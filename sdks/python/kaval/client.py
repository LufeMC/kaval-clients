"""HTTP client for the kaval REST surface. Mirrors the TS SDK contract."""

from __future__ import annotations

from collections import deque
from concurrent.futures import CancelledError
import json
import math
import os
import re
from threading import Condition, Event, Lock, Thread
import uuid
from datetime import datetime
from typing import (
    Any,
    Callable,
    Generator,
    Iterator,
    Literal,
    Mapping,
    Optional,
    TypeVar,
    cast,
)
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import httpx

from .models import (
    ActionContext,
    ActionReversibility,
    CommerceActionTimeGateInput,
    CommerceActionTimeGateResult,
    DecisionThreshold,
    Materiality,
    LiveOfferSearchResult,
    OfferSearchInput,
    OfferSearchFinalEvent,
    OfferSearchProgressEvent,
    OfferSearchReplayEvent,
    OfferSearchStreamEvent,
    ProofGateResult,
    ProofPacket,
    ProductResearchInput,
    ProductResearchProgressEvent,
    ProductResearchReplayEvent,
    ProductResearchResult,
    ProductResearchStreamEvent,
    RecordRef,
)

# One of: current_later_contradicted | stale_caught_real | stale_was_false_alarm | relied_and_correct
OutcomeKind = str

# Speed/depth tier for verify(): instant (cache/prior only, no LLM) | fast | auto (default) | deep
VerifyMode = Literal["instant", "fast", "auto", "deep"]

# The hosted kaval cloud. Override with `base_url=...` to point at a self-hosted `kaval-server`.
DEFAULT_BASE_URL = "https://api.usekaval.com"
MAX_BILLABLE_ATTEMPTS = 2
AMBIGUOUS_IDEMPOTENCY_CODES = {
    "idempotency_in_progress",
    "idempotency_resolution_pending",
    "event_persistence_pending",
}


class KavalError(Exception):
    """Raised when the API returns a non-2xx response."""

    def __init__(
        self, status_code: int, payload: Any, *, idempotency_key: Optional[str] = None
    ) -> None:
        super().__init__(f"kaval {status_code}: {payload}")
        self.status_code = status_code
        self.payload = payload
        self.idempotency_key = idempotency_key


class KavalCancelledError(CancelledError):
    """Raised when a caller cancels a synchronous Kaval operation."""

    def __init__(
        self,
        reason: object = None,
        *,
        idempotency_key: Optional[str] = None,
    ) -> None:
        if reason is None:
            message = "kaval operation cancelled"
        elif isinstance(reason, BaseException):
            message = str(reason) or reason.__class__.__name__
        else:
            message = str(reason)
        super().__init__(message)
        self.reason = reason
        self.idempotency_key = idempotency_key


class KavalCancellationToken:
    """Thread-safe, one-shot cancellation signal for synchronous Kaval calls.

    Call ``cancel()`` from another thread to release a caller blocked on HTTP I/O. The first
    cancellation wins and its optional reason is exposed on ``KavalCancelledError``.
    """

    def __init__(self) -> None:
        self._event = Event()
        self._lock = Lock()
        self._reason: object = None
        self._callbacks: dict[int, Callable[[], None]] = {}
        self._next_callback_id = 0

    @property
    def cancelled(self) -> bool:
        """Whether cancellation has been requested."""
        return self._event.is_set()

    @property
    def reason(self) -> object:
        """The first reason passed to ``cancel()``, or ``None``."""
        with self._lock:
            return self._reason

    def cancel(self, reason: object = None) -> bool:
        """Cancel once, returning ``True`` only for the call that changed state."""
        with self._lock:
            if self._event.is_set():
                return False
            self._reason = reason
            self._event.set()
            callbacks = list(self._callbacks.values())
            self._callbacks.clear()
        for callback in callbacks:
            try:
                callback()
            except Exception:
                # Cancellation must remain reliable even if best-effort transport cleanup fails.
                pass
        return True

    def wait(self, timeout: Optional[float] = None) -> bool:
        """Wait until cancelled, returning ``False`` if ``timeout`` elapses first."""
        return self._event.wait(timeout)

    def raise_if_cancelled(self) -> None:
        """Raise ``KavalCancelledError`` when cancellation has been requested."""
        self._raise_if_cancelled()

    def _raise_if_cancelled(self, idempotency_key: Optional[str] = None) -> None:
        if self._event.is_set():
            raise KavalCancelledError(
                self.reason,
                idempotency_key=idempotency_key,
            )

    def _register(self, callback: Callable[[], None]) -> Callable[[], None]:
        with self._lock:
            if self._event.is_set():
                callback_id: Optional[int] = None
            else:
                callback_id = self._next_callback_id
                self._next_callback_id += 1
                self._callbacks[callback_id] = callback
        if callback_id is None:
            try:
                callback()
            except Exception:
                pass

        def unregister() -> None:
            if callback_id is not None:
                with self._lock:
                    self._callbacks.pop(callback_id, None)

        return unregister


_ResultT = TypeVar("_ResultT")


def _safe_call(callback: Callable[[], None]) -> None:
    try:
        callback()
    except Exception:
        pass


def _run_cleanup(callback: Callable[[], None]) -> None:
    """Start best-effort cleanup without delaying the cancelled caller.

    A synchronous transport's public ``close()`` hook is allowed to block. Cleanup therefore
    belongs to a daemon worker after cancellation: the operation's finite httpx timeout remains
    the backstop for a transport that cannot be interrupted by close.
    """

    try:
        Thread(
            target=lambda: _safe_call(callback),
            name="kaval-cancellable-cleanup",
            daemon=True,
        ).start()
    except RuntimeError:
        # Thread exhaustion must not turn best-effort cleanup into a blocking cancellation path.
        pass


def _once(callback: Callable[[], None]) -> Callable[[], None]:
    """Return a thread-safe callback that invokes ``callback`` at most once."""

    lock = Lock()
    called = False

    def invoke() -> None:
        nonlocal called
        with lock:
            if called:
                return
            called = True
        callback()

    return invoke


def _run_cancellable(
    operation: Callable[[], _ResultT],
    cancellation_token: Optional[KavalCancellationToken],
    *,
    idempotency_key: Optional[str] = None,
    dispose_late: Optional[Callable[[_ResultT], None]] = None,
    on_cancel: Optional[Callable[[], None]] = None,
) -> _ResultT:
    """Run blocking sync I/O while allowing another thread to release this caller.

    httpx has no AbortSignal equivalent for its synchronous transport. A daemon worker owns the
    blocking call; cancellation wakes the caller immediately, prevents retries, and requests
    closure of any response that is already available or arrives later. A finite transport timeout
    remains the portable cleanup backstop when public close cannot interrupt a blocking I/O call.
    """
    if cancellation_token is None:
        return operation()
    if cancellation_token.cancelled:
        if on_cancel is not None:
            _run_cleanup(on_cancel)
        cancellation_token._raise_if_cancelled(idempotency_key)

    wake = Event()
    state_lock = Lock()
    outcome: list[tuple[bool, Any]] = []
    abandoned = [False]

    def worker() -> None:
        try:
            cancellation_token._raise_if_cancelled(idempotency_key)
            value: Any = operation()
            completed = (True, value)
        except BaseException as error:
            completed = (False, error)

        late_value: Any = None
        should_dispose = False
        with state_lock:
            if abandoned[0]:
                if completed[0] and dispose_late is not None:
                    late_value = completed[1]
                    should_dispose = True
            else:
                outcome.append(completed)
        if should_dispose and dispose_late is not None:
            disposer = dispose_late
            _safe_call(lambda: disposer(late_value))
        wake.set()

    unregister = cancellation_token._register(wake.set)
    if cancellation_token.cancelled:
        unregister()
        if on_cancel is not None:
            _run_cleanup(on_cancel)
        cancellation_token._raise_if_cancelled(idempotency_key)

    Thread(target=worker, name="kaval-cancellable-http", daemon=True).start()
    wake.wait()
    unregister()

    value_to_dispose: Any = None
    should_dispose = False
    with state_lock:
        if cancellation_token.cancelled:
            abandoned[0] = True
            if outcome:
                completed = outcome.pop()
                if completed[0] and dispose_late is not None:
                    value_to_dispose = completed[1]
                    should_dispose = True
            completed = None
        else:
            completed = outcome.pop() if outcome else None

    if cancellation_token.cancelled:
        if on_cancel is not None:
            _run_cleanup(on_cancel)
        if should_dispose and dispose_late is not None:
            disposer = dispose_late
            _run_cleanup(lambda: disposer(value_to_dispose))
        cancellation_token._raise_if_cancelled(idempotency_key)

    if completed is None:
        raise RuntimeError("cancellable operation completed without an outcome")
    if completed[0]:
        return cast(_ResultT, completed[1])
    raise completed[1]


def _iter_lines_cancellable(
    response: httpx.Response,
    cancellation_token: Optional[KavalCancellationToken],
    *,
    idempotency_key: str,
    close_response: Optional[Callable[[], None]] = None,
) -> Iterator[str]:
    if cancellation_token is None:
        yield from response.iter_lines()
        return
    cancellation_token._raise_if_cancelled(idempotency_key)

    condition = Condition()
    pending: deque[tuple[Literal["line", "error", "done"], Any]] = deque()
    stopped = [False]

    def publish(kind: Literal["line", "error", "done"], value: Any) -> bool:
        with condition:
            while pending and not stopped[0]:
                condition.wait()
            if stopped[0]:
                return False
            pending.append((kind, value))
            condition.notify_all()
            return True

    def producer() -> None:
        try:
            for line in response.iter_lines():
                if not publish("line", line):
                    return
        except BaseException as error:
            publish("error", error)
        else:
            publish("done", None)

    cleanup = close_response or response.close

    def cancel_response() -> None:
        with condition:
            condition.notify_all()
        _run_cleanup(cleanup)

    unregister = cancellation_token._register(cancel_response)
    try:
        cancellation_token._raise_if_cancelled(idempotency_key)
        Thread(
            target=producer,
            name="kaval-cancellable-stream",
            daemon=True,
        ).start()
        while True:
            with condition:
                while not pending and not cancellation_token.cancelled:
                    condition.wait()
                if cancellation_token.cancelled:
                    stopped[0] = True
                    condition.notify_all()
                    item = None
                else:
                    item = pending.popleft()
                    condition.notify_all()
            if item is None:
                cancellation_token._raise_if_cancelled(idempotency_key)
                raise RuntimeError("cancelled stream resumed without cancellation")
            kind, value = item
            if kind == "line":
                yield cast(str, value)
            elif kind == "error":
                raise value
            else:
                return
    finally:
        unregister()
        with condition:
            stopped[0] = True
            condition.notify_all()


def _clean(body: dict[str, Any]) -> dict[str, Any]:
    """Drop None-valued keys so optional params are omitted from the request."""
    return {k: v for k, v in body.items() if v is not None}


def _api_error_code(payload: Any) -> Optional[str]:
    if not isinstance(payload, dict):
        return None
    error = payload.get("error")
    if not isinstance(error, dict):
        return None
    code = error.get("code")
    return code if isinstance(code, str) else None


def _attach_idempotency_key(error: BaseException, operation_key: str) -> None:
    """Attach a recovery diagnostic without changing the exception's public type."""
    setattr(error, "idempotency_key", operation_key)


_COMMERCE_ACTION_TIME_GATE_STATES = {
    "current_review_only",
    "not_found",
    "stale_generation",
    "binding_mismatch",
    "expired",
    "invalidated",
    "refresh_required",
    "source_revoked",
    "retention_unavailable",
    "integrity_failed",
    "operational_failure",
}
_OFFER_SEARCH_PROGRESS_STAGES = {
    "accepted",
    "acquisition",
    "verification",
    "coverage",
    "candidate_provisional",
    "candidate",
    "warning",
}


def _valid_digest(value: Any) -> bool:
    if (
        not isinstance(value, str)
        or not value.startswith("sha256:")
        or len(value) != 71
    ):
        return False
    return all(character in "0123456789abcdef" for character in value[7:])


def _string_list(value: Any) -> bool:
    return isinstance(value, list) and all(isinstance(item, str) for item in value)


def _valid_action_binding(value: Any) -> bool:
    return (
        isinstance(value, dict)
        and isinstance(value.get("action_slot_key"), str)
        and bool(value["action_slot_key"])
        and _valid_digest(value.get("action_input_digest"))
        and _valid_digest(value.get("action_consequence_digest"))
        and value["action_input_digest"] != value["action_consequence_digest"]
    )


def _contains_commerce_authority(value: Any) -> bool:
    """Detect permission-shaped fields in current and future commerce response extensions."""
    if isinstance(value, list):
        return any(_contains_commerce_authority(item) for item in value)
    if not isinstance(value, dict):
        return False
    for key, nested in value.items():
        authority_token = nested.upper() if isinstance(nested, str) else None
        if (
            key
            in {
                "safe_to_quote",
                "action_authorized",
                "execution_allowed",
                "executionAllowed",
                "act",
            }
            and nested is True
        ):
            return True
        if key == "permission" and nested != "withheld":
            return True
        if key in {"decision", "disposition", "state"} and authority_token in {
            "ALLOW",
            "BLOCK",
            "SAFE_TO_QUOTE",
        }:
            return True
        if _contains_commerce_authority(nested):
            return True
    return False


def _review_only_commerce_action_time_gate_result(
    payload: Any,
    expected_generation: Mapping[str, Any] | None = None,
) -> CommerceActionTimeGateResult:
    """Validate the exact final-fence response and fail closed on commerce authority drift."""
    valid = (
        isinstance(payload, dict)
        and payload.get("state") in _COMMERCE_ACTION_TIME_GATE_STATES
        and payload.get("disposition") == "REVIEW"
        and payload.get("permission") == "withheld"
        and _string_list(payload.get("reason_codes"))
        and isinstance(payload.get("checked_at"), str)
        and isinstance(payload.get("final_fence_checked"), bool)
        and (
            "generation_id" not in payload or isinstance(payload["generation_id"], str)
        )
        and (
            "generation_number" not in payload
            or (
                isinstance(payload["generation_number"], int)
                and not isinstance(payload["generation_number"], bool)
                and payload["generation_number"] > 0
            )
        )
        and (
            "generation_digest" not in payload
            or _valid_digest(payload["generation_digest"])
        )
        and ("expires_at" not in payload or isinstance(payload["expires_at"], str))
        and not _contains_commerce_authority(payload)
    )
    if not valid:
        raise TypeError(
            "Offer Search action-time gate returned an invalid or authority-bearing response; "
            "commerce permission must remain withheld"
        )
    if payload["state"] == "current_review_only" and not (
        payload["final_fence_checked"] is True
        and isinstance(payload.get("generation_id"), str)
        and bool(payload["generation_id"])
        and isinstance(payload.get("generation_number"), int)
        and not isinstance(payload["generation_number"], bool)
        and payload["generation_number"] > 0
        and _valid_digest(payload.get("generation_digest"))
        and (
            expected_generation is None
            or (
                payload["generation_id"] == expected_generation["generation_id"]
                and payload["generation_number"]
                == expected_generation["generation_number"]
                and payload["generation_digest"]
                == expected_generation["generation_digest"]
            )
        )
    ):
        raise TypeError(
            "Offer Search action-time gate returned an invalid or authority-bearing response; "
            "commerce permission must remain withheld"
        )
    return cast(CommerceActionTimeGateResult, payload)


def _validate_commerce_lifecycle(payload: Any, candidates: list[Any]) -> None:
    if not isinstance(payload, dict):
        raise TypeError("Offer Search returned invalid lifecycle metadata")
    if payload.get("persistence") == "persisted":
        valid = (
            isinstance(payload.get("dependency_id"), str)
            and isinstance(payload.get("generation_id"), str)
            and isinstance(payload.get("generation_number"), int)
            and not isinstance(payload.get("generation_number"), bool)
            and payload["generation_number"] > 0
            and _valid_digest(payload.get("generation_digest"))
            and _valid_digest(payload.get("selected_candidate_id"))
            and isinstance(payload.get("expires_at"), str)
            and _valid_action_binding(payload.get("action_binding"))
        )
        if not valid:
            raise TypeError("Offer Search returned invalid lifecycle metadata")
        selected_matches = sum(
            isinstance(candidate, dict)
            and candidate.get("candidate_id") == payload["selected_candidate_id"]
            for candidate in candidates
        )
        if selected_matches != 1:
            raise TypeError("Offer Search returned invalid lifecycle metadata")
        expected_generation = {
            "generation_id": payload["generation_id"],
            "generation_number": payload["generation_number"],
            "generation_digest": payload["generation_digest"],
        }
        gate = _review_only_commerce_action_time_gate_result(
            payload.get("action_time_gate"),
            expected_generation,
        )
        if (
            (
                "generation_id" in gate
                and gate["generation_id"] != payload["generation_id"]
            )
            or (
                "generation_number" in gate
                and gate["generation_number"] != payload["generation_number"]
            )
            or (
                "generation_digest" in gate
                and gate["generation_digest"] != payload["generation_digest"]
            )
        ):
            raise TypeError("Offer Search returned invalid lifecycle metadata")
        return
    if payload.get("persistence") == "not_created" and _string_list(
        payload.get("reason_codes")
    ):
        gate = _review_only_commerce_action_time_gate_result(
            payload.get("action_time_gate")
        )
        if gate["state"] == "not_found":
            return
    raise TypeError("Offer Search returned invalid lifecycle metadata")


def _review_only_offer_search_result(
    payload: Any,
    expected_request_id: str | None = None,
) -> LiveOfferSearchResult:
    """Fail closed if a drifted commerce response could be mistaken for action permission."""
    if not isinstance(payload, dict):
        raise TypeError("Offer Search returned a non-review-only response")
    if (
        not isinstance(payload.get("request_id"), str)
        or not payload["request_id"]
        or not _valid_digest(payload.get("request_digest"))
    ):
        raise TypeError("Offer Search returned an invalid request ID or digest binding")
    if expected_request_id is not None and payload["request_id"] != expected_request_id:
        raise TypeError("Offer Search result is bound to another request")
    action = payload.get("action")
    candidates = payload.get("candidates")
    valid_action = (
        isinstance(action, dict)
        and action.get("state") in {"NEEDS_REVIEW", "NO_RELIABLE_OFFER"}
        and action.get("decision") != "ALLOW"
        and action.get("safe_to_quote") is not True
    )
    valid_candidates = isinstance(candidates, list) and all(
        isinstance(candidate, dict)
        and candidate.get("disposition") in {"review", "rejected"}
        and candidate.get("safe_to_quote") is not True
        for candidate in candidates
    )
    if (
        payload.get("schema_revision") != 2
        or payload.get("decision") == "ALLOW"
        or payload.get("safe_to_quote") is True
        or _contains_commerce_authority(payload)
        or not valid_action
        or not valid_candidates
    ):
        raise TypeError(
            "Offer Search returned a non-review-only response; "
            "shadow results cannot authorize an action"
        )
    source_attempts = payload.get("source_attempts")
    receipt = payload.get("receipt")
    valid_browser_metrics = (
        not isinstance(source_attempts, list)
        or all(
            not isinstance(attempt, dict)
            or "browser_attempted" not in attempt
            or isinstance(attempt["browser_attempted"], bool)
            for attempt in source_attempts
        )
    ) and (
        not isinstance(receipt, dict)
        or "browser_attempt_count" not in receipt
        or _safe_nonnegative_integer(receipt["browser_attempt_count"])
    )
    if not valid_browser_metrics:
        raise TypeError("Offer Search returned invalid browser metrics")
    if "lifecycle" in payload:
        _validate_commerce_lifecycle(payload["lifecycle"], cast(list[Any], candidates))
    return cast(LiveOfferSearchResult, payload)


def _review_only_offer_search_progress_event(payload: Any) -> OfferSearchProgressEvent:
    """Validate one progressive event before exposing it to an agent."""
    valid = (
        isinstance(payload, dict)
        and payload.get("type") in _OFFER_SEARCH_PROGRESS_STAGES
        and isinstance(payload.get("sequence"), int)
        and not isinstance(payload.get("sequence"), bool)
        and payload["sequence"] >= 0
        and isinstance(payload.get("at"), str)
        and isinstance(payload.get("request_id"), str)
        and isinstance(payload.get("message"), str)
        and payload.get("authority") == "research_only"
        and payload.get("action_state") == "REVIEW"
        and isinstance(payload.get("details"), dict)
        and not _contains_commerce_authority(payload)
    )
    if not valid:
        raise TypeError(
            "Offer Search stream returned an invalid or authority-bearing progress event"
        )
    if payload["type"] == "candidate_provisional":
        details = payload["details"]
        candidate = details.get("candidate") if isinstance(details, dict) else None
        provisional_valid = (
            isinstance(details, dict)
            and _valid_digest(details.get("request_digest"))
            and isinstance(details.get("origin_sequence"), int)
            and not isinstance(details.get("origin_sequence"), bool)
            and details["origin_sequence"] >= 0
            and details.get("publication_state") == "provisional"
            and details.get("durable") is False
            and details.get("actionable") is False
            and details.get("permission") == "withheld"
            and details.get("final_inclusion") == "not_yet_determined"
            and isinstance(candidate, dict)
            and _valid_digest(candidate.get("candidate_id"))
            and isinstance(candidate.get("origin_url"), str)
            and isinstance(candidate.get("source_id"), str)
            and candidate.get("disposition") in {"review", "rejected"}
        )
        if not provisional_valid:
            raise TypeError(
                "Offer Search stream returned an invalid provisional candidate event"
            )
    return cast(OfferSearchProgressEvent, payload)


def _review_only_offer_search_replay_event(
    payload: Any,
    expected_request_id: str | None = None,
) -> OfferSearchReplayEvent:
    """Validate the explicit no-new-work event emitted for a durable same-key replay."""
    valid = (
        isinstance(payload, dict)
        and payload.get("type") == "replay"
        and isinstance(payload.get("sequence"), int)
        and not isinstance(payload.get("sequence"), bool)
        and payload["sequence"] >= 0
        and isinstance(payload.get("replayed_at"), str)
        and isinstance(payload.get("request_id"), str)
        and bool(payload["request_id"])
        and _valid_digest(payload.get("request_digest"))
        and (
            expected_request_id is None or payload["request_id"] == expected_request_id
        )
        and payload.get("authority") == "research_only"
        and payload.get("action_state") == "REVIEW"
        and not _contains_commerce_authority(payload)
    )
    if not valid:
        raise TypeError(
            "Offer Search stream returned an invalid or authority-bearing replay event"
        )
    return cast(OfferSearchReplayEvent, payload)


def _parse_offer_search_sse_frame(
    lines: list[str],
    *,
    last_sequence: int,
    idempotency_key: str,
    expected_request_id: str,
    stream_request_digest: str | None,
) -> tuple[
    OfferSearchStreamEvent | None,
    int,
    LiveOfferSearchResult | None,
    str | None,
]:
    event_name: str | None = None
    id_text: str | None = None
    data_lines: list[str] = []
    for line in lines:
        if not line or line.startswith(":"):
            continue
        field, separator, value = line.partition(":")
        if separator and value.startswith(" "):
            value = value[1:]
        if field == "event":
            event_name = value
        elif field == "id":
            id_text = value
        elif field == "data":
            data_lines.append(value)
    if event_name is None or not data_lines:
        return None, last_sequence, None, stream_request_digest

    try:
        payload: Any = json.loads("\n".join(data_lines))
    except (TypeError, ValueError) as error:
        _attach_idempotency_key(error, idempotency_key)
        raise

    event_sequence: int | None = None
    if id_text is not None:
        try:
            event_sequence = int(id_text)
        except ValueError as error:
            raise TypeError("Offer Search stream event ID is invalid") from error
        if event_sequence < 0 or str(event_sequence) != id_text:
            raise TypeError("Offer Search stream event ID is invalid")

    if event_name == "error":
        status = payload.get("status") if isinstance(payload, dict) else None
        raise KavalError(
            status if isinstance(status, int) and not isinstance(status, bool) else 500,
            payload,
            idempotency_key=idempotency_key,
        )

    if event_name == "final":
        result = _review_only_offer_search_result(payload, expected_request_id)
        if (
            stream_request_digest is not None
            and result["request_digest"] != stream_request_digest
        ):
            raise TypeError(
                "Offer Search stream events are bound to another final result"
            )
        sequence = event_sequence if event_sequence is not None else last_sequence + 1
        if sequence <= last_sequence:
            raise TypeError("Offer Search stream sequence is not monotonic")
        event = cast(
            OfferSearchFinalEvent,
            {"type": "final", "sequence": sequence, "result": result},
        )
        return event, sequence, result, stream_request_digest

    if event_name == "replay":
        event = _review_only_offer_search_replay_event(payload, expected_request_id)
    else:
        event = _review_only_offer_search_progress_event(payload)
        if event["request_id"] != expected_request_id:
            raise TypeError("Offer Search stream progress request ID is invalid")
    sequence = event["sequence"]
    if event["type"] != event_name or (
        event_sequence is not None and event_sequence != sequence
    ):
        raise TypeError("Offer Search stream event sequence or type is invalid")
    if sequence <= last_sequence:
        raise TypeError("Offer Search stream sequence is not monotonic")
    if event["type"] == "replay":
        replay_digest = event["request_digest"]
        if stream_request_digest is not None and replay_digest != stream_request_digest:
            raise TypeError("Offer Search replay request binding changed")
        stream_request_digest = replay_digest
    if event["type"] == "candidate_provisional":
        candidate_digest = event["details"]["request_digest"]
        if (
            stream_request_digest is not None
            and candidate_digest != stream_request_digest
        ):
            raise TypeError(
                "Offer Search provisional candidate request binding changed"
            )
        stream_request_digest = candidate_digest
    return event, sequence, None, stream_request_digest


_PRODUCT_RESEARCH_OPERATIONAL_STATES = {
    "complete",
    "partial",
    "failed",
    "cancelled",
}
_PRODUCT_RESEARCH_STATES = {
    "offers_found",
    "refinement_required",
    "no_verified_offers",
    "not_completed",
}
_PRODUCT_RESEARCH_LISTING_KINDS = {"purchase", "rental", "quote_only"}
_PRODUCT_RESEARCH_RELATIONSHIPS = {
    "primary_product",
    "substitute",
    "accessory",
    "replacement_part",
    "consumable",
    "unknown",
}
_PRODUCT_RESEARCH_MATCH_STATES = {"exact", "possible", "conflicting"}
_PRODUCT_RESEARCH_SOURCE_FAMILIES = {
    "catalog",
    "merchant_feed",
    "retailer_origin",
    "shopping_search",
    "open_web",
}
_PRODUCT_RESEARCH_OBSERVED_LISTING_KINDS = _PRODUCT_RESEARCH_LISTING_KINDS | {"unknown"}
_PRODUCT_RESEARCH_CLUE_KINDS = {
    "brand",
    "manufacturer",
    "family",
    "model_like",
    "identifier",
    "dimension",
    "gauge",
    "thread",
    "voltage",
    "power_source",
    "capacity",
    "material",
    "color",
    "compatibility",
    "included_component",
    "performance_rating",
    "pack",
    "condition",
    "purchase_intent",
    "rental_intent",
    "quote_intent",
    "accessory_intent",
    "location_sensitive",
    "search_phrase",
}


def _safe_nonnegative_integer(value: Any) -> bool:
    return (
        isinstance(value, int)
        and not isinstance(value, bool)
        and 0 <= value <= 9_007_199_254_740_991
    )


def _safe_positive_integer(value: Any) -> bool:
    return (
        isinstance(value, int)
        and not isinstance(value, bool)
        and 0 < value <= 9_007_199_254_740_991
    )


def _exact_keys(
    value: Any, required: set[str], optional: set[str] | None = None
) -> bool:
    return (
        isinstance(value, dict)
        and required <= value.keys()
        and value.keys() <= required | (optional or set())
    )


def _timestamp_value(value: Any) -> float | None:
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


_OFFSET_TIMESTAMP = re.compile(
    r"^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d"
    r"(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$"
)


def _offset_timestamp_value(value: Any) -> float | None:
    if not isinstance(value, str) or _OFFSET_TIMESTAMP.fullmatch(value) is None:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None or parsed.utcoffset() is None:
            return None
        return parsed.timestamp()
    except ValueError:
        return None


def _valid_product_research_clue(value: Any) -> bool:
    if not _exact_keys(
        value,
        {
            "clue_id",
            "kind",
            "value",
            "normalized_value",
            "authority",
            "provenance",
        },
        {"unit", "identifier"},
    ):
        return False
    provenance = value.get("provenance")
    if not _exact_keys(provenance, {"source", "field"}, {"span"}):
        return False
    source = provenance.get("source")
    span = provenance.get("span")
    query_text = source == "query_text"
    valid_span = (
        _exact_keys(span, {"encoding", "start", "end", "text"})
        and span.get("encoding") == "utf16_code_unit"
        and _safe_nonnegative_integer(span.get("start"))
        and _safe_positive_integer(span.get("end"))
        and span["end"] > span["start"]
        and isinstance(span.get("text"), str)
        and 1 <= len(span["text"]) <= 1_000
    )
    kind = value.get("kind")
    identifier = value.get("identifier")
    return (
        _trimmed_bounded_string(value.get("clue_id"), 256)
        and kind in _PRODUCT_RESEARCH_CLUE_KINDS
        and _trimmed_bounded_string(value.get("value"), 1_000)
        and _trimmed_bounded_string(value.get("normalized_value"), 1_000)
        and ("unit" not in value or _trimmed_bounded_string(value.get("unit"), 64))
        and (
            (kind == "identifier" and _valid_product_research_identifier(identifier))
            or (kind != "identifier" and "identifier" not in value)
        )
        and value.get("authority") in {"asserted", "retrieval_only"}
        and not (
            value.get("authority") == "asserted"
            and (kind != "identifier" or source == "model_proposal")
        )
        and source in {"query_text", "request_filter", "model_proposal"}
        and _trimmed_bounded_string(provenance.get("field"), 128)
        and (
            (query_text and valid_span) or (not query_text and "span" not in provenance)
        )
    )


def _valid_product_research_interpretation(
    value: Any, expected_query: str | None = None
) -> bool:
    if not isinstance(value, dict):
        return False
    bundle = value.get("query_bundle")
    queries = bundle.get("queries") if isinstance(bundle, dict) else None
    listing_intent = value.get("listing_intent")
    clues = value.get("clues")
    asserted_identifier = isinstance(clues, list) and any(
        isinstance(clue, dict)
        and clue.get("kind") == "identifier"
        and clue.get("authority") == "asserted"
        for clue in clues
    )
    return (
        _exact_keys(
            value,
            {
                "schema_revision",
                "interpreter_version",
                "original_query",
                "normalized_query",
                "query_class",
                "identity_state",
                "listing_intent",
                "location_sensitive",
                "accessory_ambiguous",
                "clues",
                "query_bundle",
            },
        )
        and value.get("schema_revision") == 1
        and _trimmed_bounded_string(value.get("interpreter_version"), 128)
        and _trimmed_bounded_string(value.get("original_query"), 1_000)
        and len(value["original_query"]) >= 2
        and (expected_query is None or value.get("original_query") == expected_query)
        and _trimmed_bounded_string(value.get("normalized_query"), 1_000)
        and len(value["normalized_query"]) >= 2
        and value.get("query_class")
        in {
            "exact_identifier",
            "brand_model_description",
            "descriptive_product",
            "commodity_local",
            "rental_or_quote",
            "ambiguous",
        }
        and value.get("identity_state")
        in {"asserted_identifier", "candidate_only", "ambiguous"}
        and isinstance(listing_intent, list)
        and 1 <= len(listing_intent) <= 3
        and len(set(listing_intent)) == len(listing_intent)
        and all(item in _PRODUCT_RESEARCH_LISTING_KINDS for item in listing_intent)
        and isinstance(value.get("location_sensitive"), bool)
        and isinstance(value.get("accessory_ambiguous"), bool)
        and isinstance(clues, list)
        and len(clues) <= 256
        and all(_valid_product_research_clue(clue) for clue in clues)
        and len(
            {
                clue["clue_id"]
                for clue in clues
                if isinstance(clue, dict) and "clue_id" in clue
            }
        )
        == len(clues)
        and isinstance(bundle, dict)
        and _exact_keys(bundle, {"version", "queries"})
        and bundle.get("version") == "product-research-query/v1"
        and isinstance(queries, list)
        and 1 <= len(queries) <= 12
        and isinstance(queries[0], dict)
        and queries[0].get("kind") == "literal"
        and len({query.get("query_id") for query in queries if isinstance(query, dict)})
        == len(queries)
        and len(
            {
                query.get("text", "").lower()
                for query in queries
                if isinstance(query, dict) and isinstance(query.get("text"), str)
            }
        )
        == len(queries)
        and all(
            _exact_keys(
                query,
                {"query_id", "kind", "text", "rationale_codes", "authority"},
            )
            and _valid_digest(query.get("query_id"))
            and query.get("kind")
            in {
                "literal",
                "normalized",
                "exact_identifier",
                "brand_model",
                "attribute",
                "commercial",
                "construction_expansion",
                "rental",
                "quote",
            }
            and _trimmed_bounded_string(query.get("text"), 1_000)
            and len(query["text"]) >= 2
            and isinstance(query.get("rationale_codes"), list)
            and 1 <= len(query["rationale_codes"]) <= 16
            and len(set(query["rationale_codes"])) == len(query["rationale_codes"])
            and all(
                _valid_product_research_reason(reason)
                for reason in query["rationale_codes"]
            )
            and query.get("authority") == "discovery_only"
            for query in queries
        )
        and (
            value.get("identity_state") != "asserted_identifier" or asserted_identifier
        )
        and (
            value.get("query_class") != "exact_identifier"
            or value.get("identity_state") == "asserted_identifier"
        )
        and (
            value.get("query_class") != "rental_or_quote"
            or any(kind in {"rental", "quote_only"} for kind in listing_intent)
        )
    )


def _positive_finite_number(value: Any) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(value)
        and value > 0
    )


def _valid_product_research_price_basis(value: Any) -> bool:
    if not isinstance(value, dict):
        return False
    kind = value.get("kind")
    if kind == "per_orderable_item":
        return _exact_keys(value, {"kind"})
    if kind == "per_pack":
        return _exact_keys(value, {"kind", "pack_count"}) and _safe_positive_integer(
            value.get("pack_count")
        )
    if kind == "per_unit":
        return (
            _exact_keys(value, {"kind", "quantity", "unit"})
            and _positive_finite_number(value.get("quantity"))
            and _trimmed_bounded_string(value.get("unit"), 64)
        )
    if kind == "rental_period":
        return (
            _exact_keys(value, {"kind", "duration", "unit"})
            and _positive_finite_number(value.get("duration"))
            and value.get("unit") in {"hour", "day", "week", "month"}
        )
    return False


def _valid_product_research_price(value: Any) -> bool:
    if value is None:
        return True
    if not isinstance(value, dict):
        return False
    amount = value.get("amount")
    basis = value.get("basis")
    qualifiers = value.get("qualifiers")
    allowed_qualifiers = {
        "unknown",
        "standard",
        "list",
        "sale",
        "member",
        "subscription",
        "coupon",
        "trade_in",
        "installment",
        "estimated",
    }
    return (
        _exact_keys(
            value,
            {
                "amount",
                "basis",
                "qualifiers",
                "shipping_included",
                "tax_included",
            },
        )
        and isinstance(amount, dict)
        and _exact_keys(amount, {"amount_minor", "currency"})
        and _safe_nonnegative_integer(amount.get("amount_minor"))
        and isinstance(amount.get("currency"), str)
        and len(amount["currency"]) == 3
        and all("A" <= character <= "Z" for character in amount["currency"])
        and _valid_product_research_price_basis(basis)
        and isinstance(qualifiers, list)
        and 1 <= len(qualifiers) <= 9
        and all(
            isinstance(qualifier, str) and qualifier in allowed_qualifiers
            for qualifier in qualifiers
        )
        and len(set(qualifiers)) == len(qualifiers)
        and not (
            len(qualifiers) > 1
            and ("unknown" in qualifiers or "standard" in qualifiers)
        )
        and (
            isinstance(value.get("shipping_included"), bool)
            or value.get("shipping_included") is None
        )
        and (
            isinstance(value.get("tax_included"), bool)
            or value.get("tax_included") is None
        )
    )


def _canonical_product_research_url(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = urlsplit(value)
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
        ):
            return None
        secret_key = re.compile(
            r"(?:^|[_-])"
            r"(?:api[_-]?key|auth|authorization|credential|password|secret|sig(?:nature)?|token)"
            r"(?:$|[_-])",
            re.IGNORECASE,
        )
        query_items = parse_qsl(parsed.query, keep_blank_values=True)
        fragment_query = parsed.fragment
        if "=" in fragment_query and "?" in fragment_query:
            fragment_query = fragment_query.split("?", 1)[1]
        fragment_items = (
            parse_qsl(fragment_query, keep_blank_values=True)
            if "=" in fragment_query
            else []
        )
        if any(
            secret_key.search(key) is not None
            for key, _value in [*query_items, *fragment_items]
        ):
            return None
        hostname = parsed.hostname.lower()
        if ":" in hostname:
            hostname = f"[{hostname}]"
        default_port = (
            parsed.scheme == "http"
            and parsed.port == 80
            or parsed.scheme == "https"
            and parsed.port == 443
        )
        netloc = (
            hostname
            if parsed.port is None or default_port
            else f"{hostname}:{parsed.port}"
        )
        query = urlencode(sorted(query_items))
        return urlunsplit((parsed.scheme, netloc, parsed.path or "/", query, ""))
    except (TypeError, ValueError):
        return None


def _valid_product_research_delivery_money(value: Any) -> bool:
    return (
        _exact_keys(value, {"amount_minor", "currency"})
        and _safe_nonnegative_integer(value.get("amount_minor"))
        and isinstance(value.get("currency"), str)
        and len(value["currency"]) == 3
        and all("A" <= character <= "Z" for character in value["currency"])
    )


def _trimmed_bounded_string(value: Any, maximum: int) -> bool:
    return (
        isinstance(value, str) and 0 < len(value) <= maximum and value.strip() == value
    )


def _valid_product_research_delivery_promise(value: Any) -> bool:
    if value is None:
        return True
    earliest = (
        _offset_timestamp_value(value.get("earliest_at"))
        if isinstance(value, dict)
        else None
    )
    latest = (
        _offset_timestamp_value(value.get("latest_at"))
        if isinstance(value, dict)
        else None
    )
    return (
        _exact_keys(value, {"certainty", "earliest_at", "latest_at"})
        and value.get("certainty") in {"guaranteed", "estimated"}
        and earliest is not None
        and latest is not None
        and latest >= earliest
    )


def _valid_product_research_delivery(value: Any) -> bool:
    if value is None:
        return True
    required = {
        "checkout_status",
        "research_request_digest",
        "request_digest",
        "origin_url",
        "source_id",
        "adapter_revision",
        "execution_mode",
        "version_receipt",
        "destination_eligibility",
        "availability",
        "seller_authorized",
        "delivery_promise",
        "item_price",
        "shipping_price",
        "tax_price",
        "mandatory_fees",
        "declared_landed_total",
        "calculated_landed_total",
        "landed_price_state",
        "quote_id",
        "evidence_digest",
        "observed_at",
        "expires_at",
    }
    if not _exact_keys(value, required):
        return False
    observed = _offset_timestamp_value(value.get("observed_at"))
    expires = _offset_timestamp_value(value.get("expires_at"))
    promise = value.get("delivery_promise")
    if (
        value.get("checkout_status") not in {"verified", "review_required", "rejected"}
        or not _valid_digest(value.get("research_request_digest"))
        or not _valid_digest(value.get("request_digest"))
        or _canonical_product_research_url(value.get("origin_url")) is None
        or not _trimmed_bounded_string(value.get("source_id"), 256)
        or not _trimmed_bounded_string(value.get("adapter_revision"), 512)
        or value.get("execution_mode") not in {"live", "recorded_fixture"}
        or not _trimmed_bounded_string(value.get("version_receipt"), 512)
        or not value["version_receipt"].startswith(f"{value['adapter_revision']}:")
        or value.get("destination_eligibility")
        not in {"eligible", "ineligible", "unknown"}
        or value.get("availability")
        not in {"in_stock", "out_of_stock", "preorder", "unknown"}
        or (
            not isinstance(value.get("seller_authorized"), bool)
            and value.get("seller_authorized") is not None
        )
        or not _valid_product_research_delivery_promise(promise)
        or value.get("landed_price_state")
        not in {"complete", "incomplete", "invalid", "inconsistent"}
        or (
            value.get("quote_id") is not None
            and not _trimmed_bounded_string(value.get("quote_id"), 512)
        )
        or not _valid_digest(value.get("evidence_digest"))
        or observed is None
        or expires is None
        or expires <= observed
    ):
        return False
    if isinstance(promise, dict):
        promise_earliest = _offset_timestamp_value(promise.get("earliest_at"))
        if promise_earliest is None or promise_earliest < observed:
            return False
    money_keys = {
        "item_price",
        "shipping_price",
        "tax_price",
        "mandatory_fees",
        "declared_landed_total",
        "calculated_landed_total",
    }
    if any(
        value[key] is not None
        and not _valid_product_research_delivery_money(value[key])
        for key in money_keys
    ):
        return False
    currencies = {
        value[key]["currency"] for key in money_keys if value[key] is not None
    }
    if len(currencies) > 1:
        return False
    if value["landed_price_state"] == "complete":
        if any(value[key] is None for key in money_keys):
            return False
        expected = (
            value["item_price"]["amount_minor"]
            + value["shipping_price"]["amount_minor"]
            + value["tax_price"]["amount_minor"]
            + value["mandatory_fees"]["amount_minor"]
        )
        if (
            expected != value["declared_landed_total"]["amount_minor"]
            or expected != value["calculated_landed_total"]["amount_minor"]
        ):
            return False
    return not (
        value["checkout_status"] == "verified"
        and (
            value["destination_eligibility"] != "eligible"
            or value["availability"] != "in_stock"
            or value["seller_authorized"] is not True
            or value["landed_price_state"] != "complete"
        )
    )


def _product_research_delivery_binds_listing(
    delivery: Any,
    origin_url: Any,
    observed: float | None,
    expires: float | None,
) -> bool:
    if delivery is None:
        return True
    if not isinstance(delivery, dict) or observed is None or expires is None:
        return False
    delivery_observed = _timestamp_value(delivery.get("observed_at"))
    delivery_expires = _timestamp_value(delivery.get("expires_at"))
    return (
        _canonical_product_research_url(delivery.get("origin_url"))
        == _canonical_product_research_url(origin_url)
        and delivery_observed is not None
        and delivery_expires is not None
        and delivery_observed <= observed
        and expires <= delivery_expires
    )


_PRODUCT_RESEARCH_CONDITIONS = {
    "new",
    "open_box",
    "refurbished",
    "used_like_new",
    "used_good",
    "used_acceptable",
    "unknown",
}
_PRODUCT_RESEARCH_AVAILABILITIES = {
    "in_stock",
    "out_of_stock",
    "preorder",
    "unknown",
}
_PRODUCT_RESEARCH_FIELD_DERIVATIONS = {
    "publish_title",
    "publish_family",
    "publish_identity",
    "publish_attribute",
    "publish_pack",
    "publish_condition",
    "publish_origin_url",
    "derive_merchant_origin",
    "publish_seller_name",
    "classify_listing_kind",
    "classify_relationship",
    "publish_item_price",
    "derive_price_basis",
    "derive_price_qualifiers",
    "publish_availability",
}
_PRODUCT_RESEARCH_MATERIAL_FIELDS = {
    "variant_identity",
    "seller_identity",
    "condition",
    "pack",
    "item_price",
    "shipping_price",
    "tax_price",
    "mandatory_fees",
    "price_semantics",
    "total_price",
    "availability",
    "destination_eligibility",
    "purchase_url",
}
_PRODUCT_RESEARCH_TRANSFORMATIONS = {
    "trim_text",
    "canonicalize_identifier",
    "construct_product_variant",
    "normalize_pack",
    "resolve_public_url",
    "decimal_currency_to_minor_units",
    "normalize_availability",
    "normalize_attribute",
    "normalize_condition",
    "normalize_seller_name",
}
_PRODUCT_RESEARCH_REASON = re.compile(r"^[A-Z][A-Z0-9_.:-]*$")
_PRODUCT_RESEARCH_FIELD = re.compile(r"^[a-z][a-z0-9_.-]*$")


def _valid_product_research_reason(value: Any) -> bool:
    return (
        isinstance(value, str)
        and len(value) <= 128
        and value.strip() == value
        and _PRODUCT_RESEARCH_REASON.fullmatch(value) is not None
    )


def _valid_product_research_numeric_identifier(scheme: Any, value: Any) -> bool:
    lengths = {
        "gtin": {8, 12, 13, 14},
        "upc": {12},
        "ean": {8, 13},
    }
    supported = lengths.get(scheme)
    if supported is None:
        return True
    if (
        not isinstance(value, str)
        or not value.isascii()
        or not value.isdigit()
        or len(value) not in supported
    ):
        return False
    digits = [int(digit) for digit in value]
    check_digit = digits.pop()
    total = sum(
        digit * (3 if index % 2 == 0 else 1)
        for index, digit in enumerate(reversed(digits))
    )
    return (10 - (total % 10)) % 10 == check_digit


def _valid_product_research_identifier(value: Any) -> bool:
    return (
        _exact_keys(value, {"scheme", "value"}, {"issuer"})
        and value.get("scheme")
        in {"gtin", "upc", "ean", "isbn", "mpn", "manufacturer_sku", "model"}
        and _trimmed_bounded_string(value.get("value"), 256)
        and _valid_product_research_numeric_identifier(
            value.get("scheme"), value.get("value")
        )
        and ("issuer" not in value or _trimmed_bounded_string(value.get("issuer"), 256))
    )


def _valid_product_research_attribute(value: Any) -> bool:
    attribute_value = value.get("value") if isinstance(value, dict) else None
    return (
        _exact_keys(value, {"key", "value"}, {"unit"})
        and isinstance(value.get("key"), str)
        and _PRODUCT_RESEARCH_FIELD.fullmatch(value["key"]) is not None
        and (
            _trimmed_bounded_string(attribute_value, 1_000)
            if isinstance(attribute_value, str)
            else (
                isinstance(attribute_value, (int, float))
                and not isinstance(attribute_value, bool)
                and math.isfinite(attribute_value)
            )
            or isinstance(attribute_value, bool)
        )
        and ("unit" not in value or _trimmed_bounded_string(value.get("unit"), 64))
    )


def _valid_product_research_pack(value: Any) -> bool:
    return (
        _exact_keys(value, {"count"}, {"units_per_item", "unit"})
        and _safe_positive_integer(value.get("count"))
        and (
            "units_per_item" not in value
            or _positive_finite_number(value.get("units_per_item"))
        )
        and ("unit" not in value or _trimmed_bounded_string(value.get("unit"), 64))
        and (("units_per_item" in value) == ("unit" in value))
    )


def _valid_product_research_family(value: Any) -> bool:
    return value is None or (
        _exact_keys(value, set(), {"brand", "name", "category"})
        and ("brand" not in value or _trimmed_bounded_string(value.get("brand"), 256))
        and ("name" not in value or _trimmed_bounded_string(value.get("name"), 1_000))
        and (
            "category" not in value
            or _trimmed_bounded_string(value.get("category"), 512)
        )
    )


def _valid_product_research_domain(value: Any) -> bool:
    if not _trimmed_bounded_string(value, 253) or value != value.lower():
        return False
    try:
        parsed = urlsplit(f"https://{value}")
        hostname = parsed.hostname
        if hostname is None:
            return False
        canonical_hostname = f"[{hostname}]" if ":" in hostname else hostname
        return (
            canonical_hostname == value
            and parsed.port is None
            and parsed.username is None
            and parsed.password is None
            and parsed.path == ""
            and parsed.query == ""
            and parsed.fragment == ""
        )
    except (TypeError, ValueError):
        return False


def _valid_product_research_merchant(value: Any) -> bool:
    return (
        _exact_keys(value, {"display_name", "origin_domain"}, {"seller_id"})
        and (
            value.get("display_name") is None
            or _trimmed_bounded_string(value.get("display_name"), 512)
        )
        and _valid_product_research_domain(value.get("origin_domain"))
        and (
            "seller_id" not in value
            or _trimmed_bounded_string(value.get("seller_id"), 256)
        )
    )


def _valid_product_research_origin_source_value(value: Any) -> bool:
    return (
        _exact_keys(value, {"object_role", "path", "raw_value_digest"})
        and value.get("object_role")
        in {
            "product",
            "variant_parent",
            "offer",
            "embedded_product",
            "product_meta",
            "artifact_origin",
        }
        and _trimmed_bounded_string(value.get("path"), 4_096)
        and _valid_digest(value.get("raw_value_digest"))
    )


def _valid_product_research_origin_locator(value: Any) -> bool:
    source_values = value.get("source_values") if isinstance(value, dict) else None
    transformations = value.get("transformations") if isinstance(value, dict) else None
    return (
        _exact_keys(
            value,
            {
                "field_path",
                "source_values",
                "transformations",
                "observed_value_digest",
            },
        )
        and _trimmed_bounded_string(value.get("field_path"), 4_096)
        and isinstance(source_values, list)
        and 1 <= len(source_values) <= 256
        and all(
            _valid_product_research_origin_source_value(item) for item in source_values
        )
        and isinstance(transformations, list)
        and 1 <= len(transformations) <= 64
        and all(
            transformation in _PRODUCT_RESEARCH_TRANSFORMATIONS
            for transformation in transformations
        )
        and _valid_digest(value.get("observed_value_digest"))
    )


def _valid_product_research_origin_receipt(value: Any) -> bool:
    return (
        _exact_keys(
            value,
            {
                "artifact",
                "structure",
                "source_block_index",
                "product_index",
                "offer_index",
                "content_digest",
                "version_receipt",
            },
        )
        and value.get("artifact") in {"static_http_body", "rendered_page"}
        and value.get("structure")
        in {"json_ld", "embedded_product_json", "product_meta"}
        and _safe_nonnegative_integer(value.get("source_block_index"))
        and _safe_nonnegative_integer(value.get("product_index"))
        and (
            value.get("offer_index") is None
            or _safe_nonnegative_integer(value.get("offer_index"))
        )
        and _valid_digest(value.get("content_digest"))
        and (
            value.get("version_receipt") is None
            or _trimmed_bounded_string(value.get("version_receipt"), 512)
        )
    )


def _valid_product_research_evidence_binding(value: Any) -> bool:
    if not isinstance(value, dict):
        return False
    if value.get("kind") == "origin":
        locators = value.get("locators")
        return (
            _exact_keys(value, {"kind", "receipt", "locators"})
            and _valid_product_research_origin_receipt(value.get("receipt"))
            and isinstance(locators, list)
            and 1 <= len(locators) <= 64
            and all(
                _valid_product_research_origin_locator(locator) for locator in locators
            )
            and len({locator["field_path"] for locator in locators}) == len(locators)
        )
    if value.get("kind") != "structured":
        return False
    references = value.get("field_references")
    digest_fields = {
        "assessment_bundle_digest",
        "assessment_digest",
        "observation_digest",
        "source_context_digest",
        "record_digest",
        "call_outcome_digest",
        "field_receipt_digest",
    }
    return (
        _exact_keys(
            value,
            {
                "kind",
                "field_references",
                *digest_fields,
                "call_version_receipt",
            },
        )
        and isinstance(references, list)
        and 1 <= len(references) <= 16
        and all(
            _exact_keys(
                reference,
                {"material_field", "source_version_id", "evidence_span_ids"},
            )
            and reference.get("material_field") in _PRODUCT_RESEARCH_MATERIAL_FIELDS
            and _trimmed_bounded_string(reference.get("source_version_id"), 256)
            and isinstance(reference.get("evidence_span_ids"), list)
            and 1 <= len(reference["evidence_span_ids"]) <= 32
            and len(set(reference["evidence_span_ids"]))
            == len(reference["evidence_span_ids"])
            and all(
                _trimmed_bounded_string(span_id, 256)
                for span_id in reference["evidence_span_ids"]
            )
            for reference in references
        )
        and len({reference["material_field"] for reference in references})
        == len(references)
        and all(_valid_digest(value.get(field)) for field in digest_fields)
        and _trimmed_bounded_string(value.get("call_version_receipt"), 512)
    )


def _valid_product_research_field_evidence(value: Any) -> bool:
    if not _exact_keys(
        value,
        {
            "field",
            "verification_tier",
            "source_id",
            "source_url",
            "observed_at",
            "evidence_digest",
            "version_receipt",
            "evidence_binding",
            "derivations",
        },
    ):
        return False
    tier = value.get("verification_tier")
    binding = value.get("evidence_binding")
    derivations = value.get("derivations")
    if not (
        isinstance(value.get("field"), str)
        and _PRODUCT_RESEARCH_FIELD.fullmatch(value["field"]) is not None
        and tier
        in {
            "origin_verified",
            "structured_source_verified",
            "discovered_unverified",
        }
        and _trimmed_bounded_string(value.get("source_id"), 256)
        and _canonical_product_research_url(value.get("source_url")) is not None
        and _offset_timestamp_value(value.get("observed_at")) is not None
        and (
            value.get("evidence_digest") is None
            or _valid_digest(value.get("evidence_digest"))
        )
        and (
            tier == "discovered_unverified" or value.get("evidence_digest") is not None
        )
        and (
            value.get("version_receipt") is None
            or _trimmed_bounded_string(value.get("version_receipt"), 512)
        )
        and (
            tier != "structured_source_verified"
            or value.get("version_receipt") is not None
        )
        and _valid_product_research_evidence_binding(binding)
        and isinstance(derivations, list)
        and 1 <= len(derivations) <= 16
        and len(set(derivations)) == len(derivations)
        and all(
            derivation in _PRODUCT_RESEARCH_FIELD_DERIVATIONS
            for derivation in derivations
        )
    ):
        return False
    if binding["kind"] == "origin":
        receipt = binding["receipt"]
        return (
            value["evidence_digest"] is None
            or value["evidence_digest"] == receipt["content_digest"]
        ) and value["version_receipt"] == receipt["version_receipt"]
    return (
        value["evidence_digest"] == binding["field_receipt_digest"]
        and value["version_receipt"] == binding["call_version_receipt"]
    )


def _product_research_origin_hostname(value: Any) -> str | None:
    canonical = _canonical_product_research_url(value)
    return urlsplit(canonical).hostname if canonical is not None else None


def _valid_product_research_listing_evidence(value: dict[str, Any]) -> bool:
    evidence = value.get("field_evidence")
    merchant = value.get("merchant")
    tier = value.get("verification_tier")
    canonical_origin = _canonical_product_research_url(value.get("origin_url"))
    if (
        not isinstance(merchant, dict)
        or not _valid_product_research_merchant(merchant)
        or merchant["origin_domain"]
        != _product_research_origin_hostname(value.get("origin_url"))
        or not isinstance(evidence, list)
        or len(evidence) > 256
    ):
        return False
    if tier == "discovered_unverified":
        return not evidence
    if (
        not evidence
        or not all(
            _valid_product_research_field_evidence(item)
            and item["verification_tier"] == tier
            and _canonical_product_research_url(item["source_url"]) == canonical_origin
            and item["observed_at"] == value.get("observed_at")
            for item in evidence
        )
        or len({item["field"] for item in evidence}) != len(evidence)
    ):
        return False
    required_fields = {
        "title",
        "origin_url",
        "merchant_origin",
        "listing_kind",
    }
    if merchant["display_name"] is not None:
        required_fields.add("seller_name")
    if value.get("relationship") != "unknown":
        required_fields.add("relationship")
    if value.get("condition") != "unknown":
        required_fields.add("condition")
    if value.get("pack") is not None:
        required_fields.add("pack")
    if value.get("availability") != "unknown":
        required_fields.add("availability")
    if value.get("identifiers"):
        required_fields.add("product_identity")
    family = value.get("family")
    if isinstance(family, dict):
        required_fields.update(
            f"family.{field}"
            for field in ("brand", "name", "category")
            if field in family
        )
    attributes = value.get("attributes")
    if isinstance(attributes, list):
        required_fields.update(
            f"variant.attributes.{attribute['key']}" for attribute in attributes
        )
    if value.get("price") is not None:
        required_fields.update({"item_price", "price_basis", "price_qualifiers"})
    return required_fields <= {item["field"] for item in evidence}


def _valid_product_research_listing_price(value: dict[str, Any]) -> bool:
    price = value.get("price")
    basis = price.get("basis") if isinstance(price, dict) else None
    basis_kind = basis.get("kind") if isinstance(basis, dict) else None
    return not (
        (value.get("listing_kind") == "quote_only" and price is not None)
        or (
            value.get("listing_kind") == "rental"
            and price is not None
            and basis_kind != "rental_period"
        )
        or (value.get("listing_kind") == "purchase" and basis_kind == "rental_period")
        or (
            basis_kind == "per_pack"
            and (
                not isinstance(basis, dict)
                or not isinstance(value.get("pack"), dict)
                or basis.get("pack_count") != value["pack"].get("count")
            )
        )
    )


def _compatible_product_research_pack(offer: Any, group: Any) -> bool:
    if group is None:
        return offer is None
    return offer is None or offer == group


def _compatible_product_research_condition(offer: Any, group: Any) -> bool:
    if group == "unknown":
        return offer == "unknown"
    return offer in {"unknown", group}


def _valid_product_research_identity_evidence(value: Any) -> bool:
    if not isinstance(value, dict):
        return False
    if value.get("basis") == "descriptive":
        return _exact_keys(value, {"basis"})
    if value.get("basis") == "hard_identifier":
        return _exact_keys(
            value, {"basis", "identifier"}
        ) and _valid_product_research_identifier(value.get("identifier"))
    if value.get("basis") != "catalog_corroboration" or not _exact_keys(
        value,
        {
            "basis",
            "identifier",
            "resolution_digest",
            "resolved_target_digest",
            "independent_source_ids",
            "resolution_supporting_records",
            "authoritative_source_id",
        },
    ):
        return False
    sources = value.get("independent_source_ids")
    support = value.get("resolution_supporting_records")
    if not (
        _valid_product_research_identifier(value.get("identifier"))
        and _valid_digest(value.get("resolution_digest"))
        and _valid_digest(value.get("resolved_target_digest"))
        and isinstance(sources, list)
        and 2 <= len(sources) <= 64
        and all(_trimmed_bounded_string(source, 256) for source in sources)
        and len(set(sources)) == len(sources)
        and sources == sorted(sources)
        and isinstance(support, list)
        and 2 <= len(support) <= 64
        and all(
            _exact_keys(
                item,
                {
                    "record_digest",
                    "source_id",
                    "source_version_id",
                    "independence_group",
                    "authority",
                    "content_digest",
                    "identity_binding_key",
                },
            )
            and _valid_digest(item.get("record_digest"))
            and _trimmed_bounded_string(item.get("source_id"), 256)
            and _trimmed_bounded_string(item.get("source_version_id"), 256)
            and _trimmed_bounded_string(item.get("independence_group"), 256)
            and item.get("authority")
            in {
                "manufacturer_catalog",
                "authorized_registry",
                "merchant_catalog",
            }
            and _valid_digest(item.get("content_digest"))
            and _trimmed_bounded_string(item.get("identity_binding_key"), 1_000)
            for item in support
        )
        and len({item["record_digest"] for item in support}) == len(support)
        and [item["record_digest"] for item in support]
        == sorted(item["record_digest"] for item in support)
        and sorted({item["source_id"] for item in support}) == sources
        and len({item["independence_group"] for item in support}) >= 2
        and len({item["content_digest"] for item in support}) >= 2
        and len({item["identity_binding_key"] for item in support}) == 1
        and value.get("authoritative_source_id") in sources
    ):
        return False
    source_metadata: dict[str, tuple[str, str]] = {}
    for item in support:
        metadata = (item["independence_group"], item["authority"])
        existing = source_metadata.get(item["source_id"])
        if existing is not None and existing != metadata:
            return False
        source_metadata[item["source_id"]] = metadata
    return any(
        item["source_id"] == value["authoritative_source_id"]
        and item["authority"] in {"manufacturer_catalog", "authorized_registry"}
        for item in support
    )


def _valid_product_research_offer(
    value: Any, group: dict[str, Any] | None = None
) -> bool:
    if not isinstance(value, dict):
        return False
    observed = _offset_timestamp_value(value.get("observed_at"))
    expires = _offset_timestamp_value(value.get("expires_at"))
    warnings = value.get("warning_codes")
    return (
        _exact_keys(
            value,
            {
                "offer_id",
                "rank",
                "match_status",
                "title",
                "origin_url",
                "merchant",
                "listing_kind",
                "relationship",
                "condition",
                "pack",
                "price",
                "delivery",
                "availability",
                "verification_tier",
                "observed_at",
                "expires_at",
                "field_evidence",
                "comparison_key",
                "price_label",
                "warning_codes",
            },
        )
        and _valid_digest(value.get("offer_id"))
        and _safe_positive_integer(value.get("rank"))
        and value.get("match_status") in _PRODUCT_RESEARCH_MATCH_STATES
        and (
            group is None
            or (
                value.get("match_status") == group.get("match_status")
                and value.get("listing_kind") == group.get("listing_kind")
                and _compatible_product_research_condition(
                    value.get("condition"), group.get("condition")
                )
                and _compatible_product_research_pack(
                    value.get("pack"), group.get("pack")
                )
            )
        )
        and _trimmed_bounded_string(value.get("title"), 2_000)
        and _canonical_product_research_url(value.get("origin_url")) is not None
        and _valid_product_research_merchant(value.get("merchant"))
        and value.get("listing_kind") in _PRODUCT_RESEARCH_LISTING_KINDS
        and value.get("relationship") in _PRODUCT_RESEARCH_RELATIONSHIPS
        and value.get("condition") in _PRODUCT_RESEARCH_CONDITIONS
        and (
            value.get("pack") is None or _valid_product_research_pack(value.get("pack"))
        )
        and _valid_product_research_price(value.get("price"))
        and "delivery" in value
        and _valid_product_research_delivery(value.get("delivery"))
        and value.get("availability") in _PRODUCT_RESEARCH_AVAILABILITIES
        and value.get("verification_tier")
        in {"origin_verified", "structured_source_verified"}
        and observed is not None
        and expires is not None
        and expires > observed
        and _product_research_delivery_binds_listing(
            value.get("delivery"),
            value.get("origin_url"),
            observed,
            expires,
        )
        and _valid_product_research_listing_evidence(value)
        and (
            value.get("comparison_key") is None
            or _valid_digest(value.get("comparison_key"))
        )
        and value.get("price_label") in {None, "lowest_comparable"}
        and (
            value.get("price_label") is None or value.get("comparison_key") is not None
        )
        and not (value.get("comparison_key") is not None and value.get("price") is None)
        and isinstance(warnings, list)
        and len(warnings) <= 64
        and len(set(warnings)) == len(warnings)
        and all(_valid_product_research_reason(warning) for warning in warnings)
        and _valid_product_research_listing_price(value)
    )


def _valid_product_research_group(value: Any) -> bool:
    if not isinstance(value, dict):
        return False
    offers = value.get("offers")
    identifiers = value.get("identifiers")
    attributes = value.get("attributes")
    conflicts = value.get("conflict_codes")
    refinements = value.get("refinement_codes")
    exact = value.get("match_status") == "exact"
    conflicting = value.get("match_status") == "conflicting"
    return (
        _exact_keys(
            value,
            {
                "group_id",
                "rank",
                "match_status",
                "identity_basis",
                "identity_receipt_digest",
                "product_name",
                "identifiers",
                "attributes",
                "pack",
                "condition",
                "listing_kind",
                "relationship",
                "offers",
                "conflict_codes",
                "refinement_codes",
            },
            {"family"},
        )
        and _valid_digest(value.get("group_id"))
        and _safe_positive_integer(value.get("rank"))
        and value.get("match_status") in _PRODUCT_RESEARCH_MATCH_STATES
        and value.get("identity_basis")
        in {"hard_identifier", "catalog_corroboration", "descriptive", "conflict"}
        and (
            value.get("identity_receipt_digest") is None
            or _valid_digest(value.get("identity_receipt_digest"))
        )
        and _trimmed_bounded_string(value.get("product_name"), 2_000)
        and _valid_product_research_family(value.get("family"))
        and value.get("listing_kind") in _PRODUCT_RESEARCH_LISTING_KINDS
        and value.get("relationship") in _PRODUCT_RESEARCH_RELATIONSHIPS
        and value.get("condition") in _PRODUCT_RESEARCH_CONDITIONS
        and (
            value.get("pack") is None or _valid_product_research_pack(value.get("pack"))
        )
        and isinstance(identifiers, list)
        and len(identifiers) <= 32
        and all(_valid_product_research_identifier(item) for item in identifiers)
        and isinstance(attributes, list)
        and len(attributes) <= 64
        and all(_valid_product_research_attribute(item) for item in attributes)
        and isinstance(offers, list)
        and 1 <= len(offers) <= 100
        and len({offer.get("offer_id") for offer in offers}) == len(offers)
        and len({offer.get("rank") for offer in offers}) == len(offers)
        and all(
            _valid_product_research_offer(offer, value)
            and offer.get("relationship") == value["relationship"]
            for offer in offers
        )
        and isinstance(conflicts, list)
        and len(conflicts) <= 64
        and len(set(conflicts)) == len(conflicts)
        and all(_valid_product_research_reason(code) for code in conflicts)
        and isinstance(refinements, list)
        and len(refinements) <= 64
        and len(set(refinements)) == len(refinements)
        and all(_valid_product_research_reason(code) for code in refinements)
        and (
            not exact
            or (
                value.get("identity_basis")
                in {"hard_identifier", "catalog_corroboration"}
                and bool(identifiers)
                and value.get("identity_receipt_digest") is not None
                and not conflicts
            )
        )
        and (
            not conflicting
            or (value.get("identity_basis") == "conflict" and bool(conflicts))
        )
        and (
            conflicting or (value.get("identity_basis") != "conflict" and not conflicts)
        )
        and (
            exact
            or all(
                offer.get("comparison_key") is None and offer.get("price_label") is None
                for offer in offers
            )
        )
    )


def _valid_product_research_candidate(value: Any) -> bool:
    if not isinstance(value, dict):
        return False
    observed = _offset_timestamp_value(value.get("observed_at"))
    expires = _offset_timestamp_value(value.get("expires_at"))
    identifiers = value.get("identifiers")
    attributes = value.get("attributes")
    conflicts = value.get("conflict_codes")
    discovered_by = value.get("discovered_by")
    identity = value.get("identity_evidence")
    return (
        _exact_keys(
            value,
            {
                "candidate_id",
                "candidate_state",
                "product_name",
                "identifiers",
                "attributes",
                "pack",
                "condition",
                "listing_kind",
                "relationship",
                "price",
                "delivery",
                "availability",
                "merchant",
                "origin_url",
                "observed_at",
                "expires_at",
                "verification_tier",
                "field_evidence",
                "identity_evidence",
                "conflict_codes",
                "discovered_by",
            },
            {"family"},
        )
        and _valid_digest(value.get("candidate_id"))
        and value.get("candidate_state") in {"offer", "discovery"}
        and _trimmed_bounded_string(value.get("product_name"), 2_000)
        and _valid_product_research_family(value.get("family"))
        and isinstance(identifiers, list)
        and len(identifiers) <= 32
        and all(_valid_product_research_identifier(item) for item in identifiers)
        and len(
            {
                (
                    item["scheme"],
                    item.get("issuer"),
                    item["value"],
                )
                for item in identifiers
            }
        )
        == len(identifiers)
        and isinstance(attributes, list)
        and len(attributes) <= 64
        and all(_valid_product_research_attribute(item) for item in attributes)
        and len({item["key"] for item in attributes}) == len(attributes)
        and (
            value.get("pack") is None or _valid_product_research_pack(value.get("pack"))
        )
        and value.get("condition") in _PRODUCT_RESEARCH_CONDITIONS
        and value.get("listing_kind") in _PRODUCT_RESEARCH_OBSERVED_LISTING_KINDS
        and value.get("relationship") in _PRODUCT_RESEARCH_RELATIONSHIPS
        and (
            value.get("candidate_state") != "discovery"
            or (
                value.get("product_name") == "Unverified web result"
                and value.get("listing_kind") == "unknown"
                and value.get("relationship") == "unknown"
            )
        )
        and (
            value.get("candidate_state") != "offer"
            or value.get("listing_kind") != "unknown"
        )
        and _valid_product_research_price(value.get("price"))
        and _valid_product_research_listing_price(value)
        and "delivery" in value
        and _valid_product_research_delivery(value.get("delivery"))
        and value.get("availability") in _PRODUCT_RESEARCH_AVAILABILITIES
        and _valid_product_research_merchant(value.get("merchant"))
        and _canonical_product_research_url(value.get("origin_url")) is not None
        and observed is not None
        and expires is not None
        and expires > observed
        and _product_research_delivery_binds_listing(
            value.get("delivery"),
            value.get("origin_url"),
            observed,
            expires,
        )
        and _valid_product_research_listing_evidence(value)
        and _valid_product_research_identity_evidence(identity)
        and isinstance(identity, dict)
        and value.get("verification_tier")
        in {
            "origin_verified",
            "structured_source_verified",
            "discovered_unverified",
        }
        and (
            (
                value.get("candidate_state") == "discovery"
                and value.get("verification_tier") == "discovered_unverified"
            )
            or (
                value.get("candidate_state") == "offer"
                and value.get("verification_tier") != "discovered_unverified"
            )
        )
        and isinstance(conflicts, list)
        and len(conflicts) <= 64
        and len(set(conflicts)) == len(conflicts)
        and all(_valid_product_research_reason(code) for code in conflicts)
        and isinstance(discovered_by, list)
        and 1 <= len(discovered_by) <= 64
        and len(set(discovered_by)) == len(discovered_by)
        and all(_trimmed_bounded_string(source, 256) for source in discovered_by)
        and (
            identity.get("basis") == "descriptive"
            or any(item == identity.get("identifier") for item in identifiers)
        )
    )


def _valid_product_research_discovery(value: Any) -> bool:
    if not _exact_keys(
        value,
        {
            "discovery_id",
            "title",
            "origin_url",
            "merchant_domain",
            "listing_kind",
            "relationship",
            "discovered_price",
            "observed_at",
            "discovered_by",
            "verification_tier",
            "possible_group_id",
            "warning_codes",
        },
    ):
        return False
    discovered_by = value.get("discovered_by")
    warnings = value.get("warning_codes")
    return (
        _valid_digest(value.get("discovery_id"))
        and value.get("title") == "Unverified web result"
        and _canonical_product_research_url(value.get("origin_url")) is not None
        and _valid_product_research_domain(value.get("merchant_domain"))
        and value["merchant_domain"]
        == _product_research_origin_hostname(value["origin_url"])
        and value.get("listing_kind") in _PRODUCT_RESEARCH_OBSERVED_LISTING_KINDS
        and value.get("relationship") == "unknown"
        and _valid_product_research_price(value.get("discovered_price"))
        and not (
            value.get("listing_kind") == "quote_only"
            and value.get("discovered_price") is not None
        )
        and _offset_timestamp_value(value.get("observed_at")) is not None
        and isinstance(discovered_by, list)
        and 1 <= len(discovered_by) <= 64
        and len(set(discovered_by)) == len(discovered_by)
        and all(_trimmed_bounded_string(source, 256) for source in discovered_by)
        and value.get("verification_tier") == "discovered_unverified"
        and (
            value.get("possible_group_id") is None
            or _valid_digest(value.get("possible_group_id"))
        )
        and isinstance(warnings, list)
        and 1 <= len(warnings) <= 64
        and len(set(warnings)) == len(warnings)
        and all(_valid_product_research_reason(code) for code in warnings)
    )


_PRODUCT_RESEARCH_OUTCOME_KEYS = {
    "succeeded",
    "empty",
    "failed",
    "blocked",
    "cancelled",
    "deferred",
    "unsearched",
}


def _valid_product_research_coverage(
    coverage: Any,
    groups: Any,
    discoveries: Any,
    verified_offer_count: int,
) -> bool:
    if not isinstance(coverage, dict):
        return False
    ledger = coverage.get("source_ledger")
    receipt = coverage.get("execution_receipt")
    if not isinstance(ledger, list) or not isinstance(receipt, dict):
        return False

    def valid_ledger_entry(entry: Any) -> bool:
        if not isinstance(entry, dict):
            return False
        reasons = entry.get("reason_codes")
        outcomes = entry.get("outcome_counts")
        disposition = entry.get("disposition")
        if (
            not _exact_keys(
                entry,
                {
                    "source_id",
                    "family",
                    "origin_domain",
                    "disposition",
                    "reason_code",
                    "reason_codes",
                    "calls",
                    "outcome_counts",
                    "candidates_discovered",
                    "verified_offers",
                    "cost_micro_usd",
                    "avoided_cost_micro_usd",
                },
            )
            or not _trimmed_bounded_string(entry.get("source_id"), 256)
            or entry.get("family") not in _PRODUCT_RESEARCH_SOURCE_FAMILIES
            or (
                entry.get("origin_domain") is not None
                and not _valid_product_research_domain(entry.get("origin_domain"))
            )
            or disposition not in _PRODUCT_RESEARCH_OUTCOME_KEYS
            or not _valid_product_research_reason(entry.get("reason_code"))
            or not isinstance(reasons, list)
            or not 1 <= len(reasons) <= 128
            or len(set(reasons)) != len(reasons)
            or not all(_valid_product_research_reason(reason) for reason in reasons)
            or entry["reason_code"] not in reasons
            or not _safe_nonnegative_integer(entry.get("calls"))
            or not _safe_nonnegative_integer(entry.get("candidates_discovered"))
            or not _safe_nonnegative_integer(entry.get("verified_offers"))
            or not _safe_nonnegative_integer(entry.get("cost_micro_usd"))
            or not _safe_nonnegative_integer(entry.get("avoided_cost_micro_usd"))
            or not isinstance(outcomes, dict)
            or not _exact_keys(outcomes, _PRODUCT_RESEARCH_OUTCOME_KEYS)
            or not all(
                _safe_nonnegative_integer(outcomes.get(key))
                for key in _PRODUCT_RESEARCH_OUTCOME_KEYS
            )
        ):
            return False
        attempted = sum(
            outcomes[key] for key in {"succeeded", "empty", "failed", "cancelled"}
        )
        return (attempted <= entry["calls"] <= attempted + outcomes["blocked"]) and (
            disposition not in {"succeeded", "empty", "failed"} or entry["calls"] > 0
        )

    receipt_integer_keys = {
        "search_calls",
        "fetch_calls",
        "providers_configured",
        "providers_succeeded",
        "cost_micro_usd",
        "provider_estimated_cost_reported_search_calls",
        "discovery_cache_hits",
        "cost_avoided_micro_usd",
        "elapsed_ms",
    }
    if (
        not _exact_keys(
            receipt,
            receipt_integer_keys
            | {
                "cost_basis",
                "provider_estimated_cost_micro_usd",
                "first_useful_candidate_ms",
            },
            {"browser_attempt_count"},
        )
        or not all(
            _safe_nonnegative_integer(receipt.get(key)) for key in receipt_integer_keys
        )
        or receipt.get("cost_basis") != "reserved_ceiling"
        or (
            receipt.get("provider_estimated_cost_micro_usd") is not None
            and not _safe_nonnegative_integer(
                receipt.get("provider_estimated_cost_micro_usd")
            )
        )
        or (
            receipt.get("first_useful_candidate_ms") is not None
            and not _safe_nonnegative_integer(receipt.get("first_useful_candidate_ms"))
        )
        or (
            "browser_attempt_count" in receipt
            and not _safe_nonnegative_integer(receipt["browser_attempt_count"])
        )
        or receipt["providers_succeeded"] > receipt["providers_configured"]
        or receipt["provider_estimated_cost_reported_search_calls"]
        > receipt["search_calls"]
        or (
            receipt["provider_estimated_cost_micro_usd"] is not None
            and receipt["provider_estimated_cost_reported_search_calls"]
            != receipt["search_calls"]
        )
        or (
            receipt["provider_estimated_cost_micro_usd"] is None
            and receipt["search_calls"] > 0
            and receipt["provider_estimated_cost_reported_search_calls"]
            == receipt["search_calls"]
        )
        or (
            receipt["first_useful_candidate_ms"] is not None
            and receipt["first_useful_candidate_ms"] > receipt["elapsed_ms"]
        )
        or (
            "browser_attempt_count" in receipt
            and receipt["browser_attempt_count"] > receipt["fetch_calls"]
        )
        or (verified_offer_count > 0)
        != (receipt["first_useful_candidate_ms"] is not None)
    ):
        return False

    if (
        len(ledger) > 10_000
        or not all(valid_ledger_entry(entry) for entry in ledger)
        or len({entry["source_id"] for entry in ledger}) != len(ledger)
        or sum(entry["calls"] for entry in ledger)
        > receipt["search_calls"] + receipt["fetch_calls"]
        or sum(entry["cost_micro_usd"] for entry in ledger) > receipt["cost_micro_usd"]
        or sum(entry["avoided_cost_micro_usd"] for entry in ledger)
        > receipt["cost_avoided_micro_usd"]
    ):
        return False

    families = coverage.get("source_families_attempted")
    gaps = coverage.get("gap_codes")
    return (
        _exact_keys(
            coverage,
            {
                "claim",
                "state",
                "source_ledger",
                "execution_receipt",
                "source_families_attempted",
                "merchant_origins_attempted",
                "merchant_origins_succeeded",
                "verified_offer_count",
                "unverified_discovery_count",
                "product_group_count",
                "gap_codes",
                "stop_reason",
            },
        )
        and coverage.get("claim") == "bounded_not_comprehensive"
        and coverage.get("state") in {"bounded", "bounded_with_known_gaps", "partial"}
        and isinstance(families, list)
        and len(families) <= 5
        and len(set(families)) == len(families)
        and all(family in _PRODUCT_RESEARCH_SOURCE_FAMILIES for family in families)
        and _safe_nonnegative_integer(coverage.get("merchant_origins_attempted"))
        and _safe_nonnegative_integer(coverage.get("merchant_origins_succeeded"))
        and coverage["merchant_origins_succeeded"]
        <= coverage["merchant_origins_attempted"]
        and _safe_nonnegative_integer(coverage.get("verified_offer_count"))
        and _safe_nonnegative_integer(coverage.get("unverified_discovery_count"))
        and _safe_nonnegative_integer(coverage.get("product_group_count"))
        and coverage["verified_offer_count"] == verified_offer_count
        and coverage["product_group_count"]
        == (len(groups) if isinstance(groups, list) else -1)
        and coverage["unverified_discovery_count"]
        == (len(discoveries) if isinstance(discoveries, list) else -1)
        and isinstance(gaps, list)
        and len(gaps) <= 128
        and len(set(gaps)) == len(gaps)
        and all(_valid_product_research_reason(gap) for gap in gaps)
        and coverage.get("stop_reason")
        in {
            "coverage_satisfied",
            "source_exhausted",
            "budget_exhausted",
            "deadline_reached",
            "cancelled",
            "upstream_unavailable",
        }
    )


def _valid_product_research_warning(value: Any) -> bool:
    return (
        _exact_keys(value, {"code", "message", "scope", "subject_id"})
        and _valid_product_research_reason(value.get("code"))
        and _trimmed_bounded_string(value.get("message"), 1_000)
        and value.get("scope") in {"request", "coverage", "group", "offer", "source"}
        and (
            value.get("subject_id") is None
            or _trimmed_bounded_string(value.get("subject_id"), 256)
        )
    )


def _valid_product_research_refinement(value: Any) -> bool:
    if not _exact_keys(
        value,
        {"field", "reason_code", "prompt", "required_for", "options"},
    ):
        return False
    options = value.get("options")
    return (
        value.get("field")
        in {
            "brand",
            "model",
            "identifier",
            "size",
            "pack",
            "condition",
            "location",
            "selection",
        }
        and _valid_product_research_reason(value.get("reason_code"))
        and _trimmed_bounded_string(value.get("prompt"), 1_000)
        and value.get("required_for")
        in {
            "better_matches",
            "price_comparison",
            "delivered_price",
            "exact_handoff",
        }
        and isinstance(options, list)
        and len(options) <= 32
        and len(set(options)) == len(options)
        and all(_trimmed_bounded_string(option, 256) for option in options)
    )


def _product_research_result_times_bind(
    groups: list[Any],
    discoveries: list[Any],
    completed: float,
    expires: float,
) -> bool:
    for group in groups:
        for offer in group["offers"]:
            offer_observed = _offset_timestamp_value(offer["observed_at"])
            offer_expires = _offset_timestamp_value(offer["expires_at"])
            if (
                offer_observed is None
                or offer_expires is None
                or offer_observed > completed
                or expires > offer_expires
            ):
                return False
    for discovery in discoveries:
        discovery_observed = _offset_timestamp_value(discovery["observed_at"])
        if discovery_observed is None or discovery_observed > completed:
            return False
    return True


def _review_only_product_research_result(
    payload: Any,
    *,
    expected_query: str | None = None,
    expected_research_id: str | None = None,
    expected_request_digest: str | None = None,
) -> ProductResearchResult:
    if not isinstance(payload, dict):
        raise TypeError("Product Research returned a non-canonical result")
    authority = payload.get("authority")
    groups = payload.get("groups")
    discoveries = payload.get("unverified_discoveries")
    coverage = payload.get("coverage")
    started = _timestamp_value(payload.get("started_at"))
    completed = _timestamp_value(payload.get("completed_at"))
    expires = _timestamp_value(payload.get("expires_at"))
    verified_offer_count = (
        sum(len(group.get("offers", [])) for group in groups)
        if isinstance(groups, list) and all(isinstance(group, dict) for group in groups)
        else -1
    )
    valid_coverage = _valid_product_research_coverage(
        coverage,
        groups,
        discoveries,
        verified_offer_count,
    )
    valid = (
        _exact_keys(
            payload,
            {
                "schema_revision",
                "research_id",
                "request_digest",
                "operational_state",
                "research_state",
                "authority",
                "interpretation",
                "groups",
                "unverified_discoveries",
                "coverage",
                "warnings",
                "requested_refinements",
                "started_at",
                "completed_at",
                "expires_at",
            },
        )
        and payload.get("schema_revision") == 1
        and _trimmed_bounded_string(payload.get("research_id"), 256)
        and _valid_digest(payload.get("request_digest"))
        and (
            expected_research_id is None
            or payload["research_id"] == expected_research_id
        )
        and (
            expected_request_digest is None
            or payload["request_digest"] == expected_request_digest
        )
        and payload.get("operational_state") in _PRODUCT_RESEARCH_OPERATIONAL_STATES
        and payload.get("research_state") in _PRODUCT_RESEARCH_STATES
        and (
            (payload["operational_state"] in {"failed", "cancelled"})
            == (payload["research_state"] == "not_completed")
        )
        and authority
        == {
            "mode": "review_only",
            "action_authorized": False,
            "permission": "withheld",
        }
        and not _contains_commerce_authority(payload)
        and _valid_product_research_interpretation(
            payload.get("interpretation"), expected_query
        )
        and isinstance(groups, list)
        and len(groups) <= 100
        and all(_valid_product_research_group(group) for group in groups)
        and len({group["group_id"] for group in groups}) == len(groups)
        and len({group["rank"] for group in groups}) == len(groups)
        and all(
            offer.get("delivery") is None
            or offer["delivery"].get("research_request_digest")
            == payload["request_digest"]
            for group in groups
            for offer in group["offers"]
        )
        and isinstance(discoveries, list)
        and len(discoveries) <= 1_000
        and all(
            _valid_product_research_discovery(discovery) for discovery in discoveries
        )
        and len({discovery["discovery_id"] for discovery in discoveries})
        == len(discoveries)
        and valid_coverage
        and isinstance(payload.get("warnings"), list)
        and len(payload["warnings"]) <= 256
        and all(
            _valid_product_research_warning(warning) for warning in payload["warnings"]
        )
        and isinstance(payload.get("requested_refinements"), list)
        and len(payload["requested_refinements"]) <= 64
        and all(
            _valid_product_research_refinement(refinement)
            for refinement in payload["requested_refinements"]
        )
        and started is not None
        and completed is not None
        and expires is not None
        and completed >= started
        and expires > completed
        and _product_research_result_times_bind(
            groups,
            discoveries,
            completed,
            expires,
        )
        and (payload["research_state"] != "offers_found" or verified_offer_count > 0)
        and (
            payload["research_state"] != "no_verified_offers"
            or verified_offer_count == 0
        )
    )
    if not valid:
        raise TypeError(
            "Product Research returned an invalid or authority-bearing canonical result"
        )
    return cast(ProductResearchResult, payload)


def _review_only_product_research_progress_event(
    payload: Any,
    *,
    expected_query: str | None = None,
    expected_research_id: str | None = None,
    expected_request_digest: str | None = None,
) -> ProductResearchProgressEvent:
    common = (
        isinstance(payload, dict)
        and _trimmed_bounded_string(payload.get("research_id"), 256)
        and _valid_digest(payload.get("request_digest"))
        and _safe_nonnegative_integer(payload.get("sequence"))
        and _timestamp_value(payload.get("observed_at")) is not None
        and (
            expected_research_id is None
            or payload["research_id"] == expected_research_id
        )
        and (
            expected_request_digest is None
            or payload["request_digest"] == expected_request_digest
        )
        and not _contains_commerce_authority(payload)
    )
    if not common:
        raise TypeError(
            "Product Research stream returned an invalid or authority-bearing event"
        )
    event_type = payload.get("type")
    common_keys = {
        "type",
        "research_id",
        "request_digest",
        "sequence",
        "observed_at",
    }
    event_keys = {
        "accepted": {"query"},
        "interpreted": {"interpretation"},
        "source_progress": {"source_id", "family", "state", "reason_code"},
        "candidate_observed": {"candidate"},
        "group_updated": {"group"},
        "completed": {"result"},
        "failed": {"error_code", "message", "result"},
        "cancelled": {"reason_code", "result"},
    }
    if (
        not isinstance(event_type, str)
        or event_type not in event_keys
        or not _exact_keys(payload, common_keys | event_keys[event_type])
    ):
        raise TypeError(
            "Product Research stream returned an invalid or authority-bearing event"
        )
    valid = False
    if event_type == "accepted":
        valid = (
            _trimmed_bounded_string(payload.get("query"), 1_000)
            and len(payload["query"]) >= 2
            and (expected_query is None or payload["query"] == expected_query)
        )
    elif event_type == "interpreted":
        valid = _valid_product_research_interpretation(
            payload.get("interpretation"), expected_query
        )
    elif event_type == "source_progress":
        valid = (
            _trimmed_bounded_string(payload.get("source_id"), 256)
            and payload.get("family") in _PRODUCT_RESEARCH_SOURCE_FAMILIES
            and payload.get("state")
            in {"started", "succeeded", "empty", "failed", "blocked", "cancelled"}
            and (
                payload.get("reason_code") is None
                or _valid_product_research_reason(payload.get("reason_code"))
            )
        )
    elif event_type == "candidate_observed":
        valid = _valid_product_research_candidate(payload.get("candidate"))
    elif event_type == "group_updated":
        valid = _valid_product_research_group(payload.get("group"))
    elif event_type == "completed":
        try:
            result = _review_only_product_research_result(
                payload.get("result"),
                expected_query=expected_query,
                expected_research_id=payload["research_id"],
                expected_request_digest=payload["request_digest"],
            )
            valid = result["operational_state"] in {"complete", "partial"}
        except TypeError:
            valid = False
    elif event_type == "failed":
        try:
            result = _review_only_product_research_result(
                payload.get("result"),
                expected_query=expected_query,
                expected_research_id=payload["research_id"],
                expected_request_digest=payload["request_digest"],
            )
            valid = (
                _valid_product_research_reason(payload.get("error_code"))
                and _trimmed_bounded_string(payload.get("message"), 1_000)
                and result["operational_state"] == "failed"
            )
        except TypeError:
            valid = False
    elif event_type == "cancelled":
        try:
            result = _review_only_product_research_result(
                payload.get("result"),
                expected_query=expected_query,
                expected_research_id=payload["research_id"],
                expected_request_digest=payload["request_digest"],
            )
            valid = (
                _valid_product_research_reason(payload.get("reason_code"))
                and result["operational_state"] == "cancelled"
            )
        except TypeError:
            valid = False
    if not valid:
        raise TypeError(
            "Product Research stream returned an invalid or authority-bearing event"
        )
    return cast(ProductResearchProgressEvent, payload)


def _review_only_product_research_replay_event(
    payload: Any,
) -> ProductResearchReplayEvent:
    valid = (
        _exact_keys(
            payload,
            {
                "type",
                "sequence",
                "replayed_at",
                "research_id",
                "request_digest",
                "authority",
            },
        )
        and payload.get("type") == "replay"
        and payload.get("sequence") == 0
        and _timestamp_value(payload.get("replayed_at")) is not None
        and _trimmed_bounded_string(payload.get("research_id"), 256)
        and _valid_digest(payload.get("request_digest"))
        and payload.get("authority")
        == {
            "mode": "review_only",
            "action_authorized": False,
            "permission": "withheld",
        }
        and not _contains_commerce_authority(payload)
    )
    if not valid:
        raise TypeError(
            "Product Research stream returned an invalid or authority-bearing replay"
        )
    return cast(ProductResearchReplayEvent, payload)


def _parse_product_research_sse_frame(
    lines: list[str],
    *,
    last_sequence: int,
    last_observed_at: float | None,
    idempotency_key: str,
    expected_query: str,
    stream_research_id: str | None,
    stream_request_digest: str | None,
) -> tuple[
    ProductResearchStreamEvent | None,
    int,
    float | None,
    str | None,
    str | None,
    ProductResearchResult | None,
    bool,
]:
    event_name: str | None = None
    id_text: str | None = None
    data_lines: list[str] = []
    for line in lines:
        if not line or line.startswith(":"):
            continue
        field, separator, value = line.partition(":")
        if separator and value.startswith(" "):
            value = value[1:]
        if field == "event":
            event_name = value
        elif field == "id":
            id_text = value
        elif field == "data":
            data_lines.append(value)
    if event_name is None or not data_lines:
        return (
            None,
            last_sequence,
            last_observed_at,
            stream_research_id,
            stream_request_digest,
            None,
            False,
        )
    try:
        payload: Any = json.loads("\n".join(data_lines))
    except (TypeError, ValueError) as error:
        _attach_idempotency_key(error, idempotency_key)
        raise
    if event_name == "error":
        status = payload.get("status") if isinstance(payload, dict) else None
        raise KavalError(
            status if isinstance(status, int) and not isinstance(status, bool) else 500,
            payload,
            idempotency_key=idempotency_key,
        )
    if (
        id_text is None
        or len(id_text) > 16
        or re.fullmatch(r"(?:0|[1-9][0-9]*)", id_text) is None
    ):
        raise TypeError("Product Research stream event ID is invalid")
    sequence = int(id_text)
    if not _safe_nonnegative_integer(sequence) or sequence != last_sequence + 1:
        raise TypeError(
            "Product Research stream sequence is not contiguous and zero-based"
        )
    if event_name == "replay":
        if last_sequence != -1:
            raise TypeError("Product Research replay must be the first stream event")
        replay = _review_only_product_research_replay_event(payload)
        if replay["sequence"] != sequence:
            raise TypeError("Product Research replay sequence is invalid")
        return (
            replay,
            sequence,
            last_observed_at,
            replay["research_id"],
            replay["request_digest"],
            None,
            False,
        )
    event = _review_only_product_research_progress_event(
        payload,
        expected_query=expected_query,
        expected_research_id=stream_research_id,
        expected_request_digest=stream_request_digest,
    )
    if event["type"] != event_name or event["sequence"] != sequence:
        raise TypeError("Product Research stream event sequence or type is invalid")
    if last_sequence == -1 and event["type"] != "accepted":
        raise TypeError("Live Product Research progress must begin with accepted")
    if stream_research_id is None:
        stream_research_id = event["research_id"]
        stream_request_digest = event["request_digest"]
    observed_at = _timestamp_value(event["observed_at"])
    if observed_at is None or (
        last_observed_at is not None and observed_at < last_observed_at
    ):
        raise TypeError("Product Research stream timestamps are not monotonic")
    terminal = event["type"] in {"completed", "failed", "cancelled"}
    result = cast(
        ProductResearchResult | None,
        cast(dict[str, Any], event).get("result") if terminal else None,
    )
    return (
        event,
        sequence,
        observed_at,
        stream_research_id,
        stream_request_digest,
        result,
        terminal,
    )


class KavalClient:
    """Synchronous evidence-gate client for action decisions and review-only offer research."""

    def __init__(
        self,
        base_url: Optional[str] = None,
        api_key: Optional[str] = None,
        *,
        timeout: float = 30.0,
        transport: Optional[httpx.BaseTransport] = None,
    ) -> None:
        resolved_base = base_url or os.environ.get("KAVAL_BASE_URL") or DEFAULT_BASE_URL
        resolved_key = (
            api_key if api_key is not None else os.environ.get("KAVAL_API_KEY")
        )
        headers = {"content-type": "application/json"}
        if resolved_key:
            headers["authorization"] = f"Bearer {resolved_key}"
        self._http = httpx.Client(
            base_url=resolved_base.rstrip("/"),
            headers=headers,
            timeout=timeout,
            transport=transport,
        )

    def _post_response(
        self,
        path: str,
        body: dict[str, Any],
        *,
        headers: Optional[Mapping[str, str]] = None,
        timeout: Optional[float] = None,
        cancellation_token: Optional[KavalCancellationToken] = None,
        idempotency_key: Optional[str] = None,
    ) -> httpx.Response:
        request_options: dict[str, Any] = {}
        if timeout is not None:
            request_options["timeout"] = timeout
        if cancellation_token is None:
            return self._http.post(
                path,
                json=body,
                headers=headers,
                **request_options,
            )

        def send() -> httpx.Response:
            request = self._http.build_request(
                "POST",
                path,
                json=body,
                headers=headers,
                **request_options,
            )
            return self._http.send(request, stream=True)

        response = _run_cancellable(
            send,
            cancellation_token,
            idempotency_key=idempotency_key,
            dispose_late=lambda late_response: late_response.close(),
        )
        close_response = _once(response.close)
        try:
            _run_cancellable(
                response.read,
                cancellation_token,
                idempotency_key=idempotency_key,
                on_cancel=close_response,
            )
        except BaseException:
            if cancellation_token.cancelled:
                _run_cleanup(close_response)
            else:
                _safe_call(close_response)
            raise
        return response

    def _billable_post(
        self,
        path: str,
        body: dict[str, Any],
        *,
        idempotency_key: Optional[str] = None,
        timeout: Optional[float] = None,
        cancellation_token: Optional[KavalCancellationToken] = None,
    ) -> Any:
        operation_key = idempotency_key or str(uuid.uuid4())
        if cancellation_token is not None:
            cancellation_token._raise_if_cancelled(operation_key)
        for attempt in range(MAX_BILLABLE_ATTEMPTS):
            try:
                res = self._post_response(
                    path,
                    body,
                    headers={"idempotency-key": operation_key},
                    timeout=timeout,
                    cancellation_token=cancellation_token,
                    idempotency_key=operation_key,
                )
            except httpx.TransportError as error:
                _attach_idempotency_key(error, operation_key)
                # The server may have committed before the connection failed. Retry once with the
                # same key so a completed operation is replayed instead of billed twice.
                if attempt + 1 < MAX_BILLABLE_ATTEMPTS and not (
                    cancellation_token is not None and cancellation_token.cancelled
                ):
                    continue
                raise
            try:
                if cancellation_token is not None:
                    cancellation_token._raise_if_cancelled(operation_key)
                try:
                    payload: Any = res.json()
                except ValueError as error:
                    # Successful responses promise JSON. Preserve that contract instead of
                    # returning an unexpected string that callers may treat as a valid verdict.
                    # Error responses can come from a proxy as plain text, so retain their body.
                    if 200 <= res.status_code < 300:
                        _attach_idempotency_key(error, operation_key)
                        raise
                    payload = res.text
                if cancellation_token is not None:
                    cancellation_token._raise_if_cancelled(operation_key)
                if 200 <= res.status_code < 300:
                    return payload
                if (
                    attempt + 1 < MAX_BILLABLE_ATTEMPTS
                    and _api_error_code(payload) in AMBIGUOUS_IDEMPOTENCY_CODES
                ):
                    continue
                raise KavalError(
                    res.status_code,
                    payload,
                    idempotency_key=operation_key,
                )
            finally:
                if cancellation_token is not None and cancellation_token.cancelled:
                    _run_cleanup(res.close)
                else:
                    _safe_call(res.close)
        raise RuntimeError("unreachable billable request state")

    def _post(
        self,
        path: str,
        body: dict[str, Any],
        *,
        timeout: Optional[float] = None,
        cancellation_token: Optional[KavalCancellationToken] = None,
    ) -> Any:
        try:
            res = self._post_response(
                path,
                body,
                timeout=timeout,
                cancellation_token=cancellation_token,
            )
        except httpx.TransportError:
            if cancellation_token is not None:
                cancellation_token._raise_if_cancelled()
            raise
        try:
            if cancellation_token is not None:
                cancellation_token._raise_if_cancelled()
            try:
                payload: Any = res.json()
            except ValueError:
                payload = res.text
            if cancellation_token is not None:
                cancellation_token._raise_if_cancelled()
            if res.status_code >= 400:
                raise KavalError(res.status_code, payload)
            return payload
        finally:
            if cancellation_token is not None and cancellation_token.cancelled:
                _run_cleanup(res.close)
            else:
                _safe_call(res.close)

    def check(
        self,
        belief: str,
        *,
        context: Optional[str] = None,
        held_evidence: Optional[list[str]] = None,
        freshness_sla: Optional[str] = None,
        proof_standard: Optional[str] = None,
        idempotency_key: Optional[str] = None,
    ) -> dict[str, Any]:
        return self._billable_post(
            "/v1/check",
            _clean(
                {
                    "belief": belief,
                    "context": context,
                    "held_evidence": held_evidence,
                    "freshness_sla": freshness_sla,
                    "proof_standard": proof_standard,
                }
            ),
            idempotency_key=idempotency_key,
        )

    def verify(
        self,
        belief: str,
        *,
        context: Optional[str] = None,
        url: Optional[str] = None,
        held_at: Optional[str] = None,
        held_content_hash: Optional[str] = None,
        held_evidence: Optional[list[str]] = None,
        freshness_sla: Optional[str] = None,
        proof_standard: Optional[str] = None,
        min_confidence: Optional[float] = None,
        mode: Optional[VerifyMode] = None,
        idempotency_key: Optional[str] = None,
    ) -> dict[str, Any]:
        """Pre-action gate: the verdict plus ``act`` (True only when current and confident).
        Treat ``act`` False as 'do not rely on this belief — re-fetch first'.

        ``mode`` selects a speed/depth tier — instant (cache/prior only, no LLM) | fast | auto
        (default) | deep (full multi-source + a cited explanation). The returned dict echoes
        ``tier``, and on the deep tier adds ``explanation`` {content, citations, confidence}."""
        return self._billable_post(
            "/v1/verify",
            _clean(
                {
                    "belief": belief,
                    "context": context,
                    "url": url,
                    "held_at": held_at,
                    "held_content_hash": held_content_hash,
                    "held_evidence": held_evidence,
                    "freshness_sla": freshness_sla,
                    "proof_standard": proof_standard,
                    "minConfidence": min_confidence,
                    "mode": mode,
                }
            ),
            idempotency_key=idempotency_key,
        )

    def extract_and_check(
        self,
        text: str,
        *,
        context: Optional[str] = None,
        freshness_sla: Optional[str] = None,
        idempotency_key: Optional[str] = None,
    ) -> dict[str, Any]:
        return self._billable_post(
            "/v1/extract-and-check",
            _clean({"text": text, "context": context, "freshness_sla": freshness_sla}),
            idempotency_key=idempotency_key,
        )

    def scan_store(
        self,
        beliefs: list[str],
        *,
        freshness_sla: Optional[str] = None,
        concurrency: Optional[int] = None,
        mode: Optional[VerifyMode] = None,
        idempotency_key: Optional[str] = None,
    ) -> dict[str, Any]:
        """Sweep a belief store for drift. ``mode`` is the speed/depth tier for the whole sweep
        (default ``fast`` — cheap breadth; re-``verify`` a flagged belief at ``deep`` for the cited
        explanation). The returned dict echoes the ``tier`` the sweep ran at."""
        return self._billable_post(
            "/v1/scan-store",
            _clean(
                {
                    "beliefs": beliefs,
                    "freshness_sla": freshness_sla,
                    "concurrency": concurrency,
                    "mode": mode,
                }
            ),
            idempotency_key=idempotency_key,
        )

    def monitor(
        self,
        beliefs: list[str],
        *,
        freshness_sla: Optional[str] = None,
        concurrency: Optional[int] = None,
        mode: Optional[VerifyMode] = None,
        webhook: Optional[str] = None,
        state: Optional[dict[str, Any]] = None,
        idempotency_key: Optional[str] = None,
    ) -> dict[str, Any]:
        """Sweep a belief store and POST the NEWLY-risky beliefs to ``webhook`` (server-side delivery).
        Pass the ``state`` from the previous response to deliver only beliefs that became risky since
        then (a still-stale belief isn't re-sent every run). ``mode`` is the sweep tier (default
        ``fast``); the result echoes the ``tier`` it ran at and the ``state`` to carry into the next run."""
        return self._billable_post(
            "/v1/monitor",
            _clean(
                {
                    "beliefs": beliefs,
                    "freshness_sla": freshness_sla,
                    "concurrency": concurrency,
                    "mode": mode,
                    "webhook": webhook,
                    "state": state,
                }
            ),
            idempotency_key=idempotency_key,
        )

    def research_products(
        self,
        request: ProductResearchInput,
        *,
        idempotency_key: Optional[str] = None,
        timeout: Optional[float] = None,
        cancellation_token: Optional[KavalCancellationToken] = None,
    ) -> ProductResearchResult:
        """Research ordinary product text and return bounded, review-only evidence.

        The public request intentionally has no execution-limit knobs; authenticated workspace
        policy assigns those budgets server-side. Results never authorize quoting or purchasing.
        """
        payload = self._billable_post(
            "/v1/product-research",
            dict(request),
            idempotency_key=idempotency_key,
            timeout=timeout,
            cancellation_token=cancellation_token,
        )
        return _review_only_product_research_result(
            payload, expected_query=request["query"]
        )

    def stream_product_research(
        self,
        request: ProductResearchInput,
        *,
        idempotency_key: Optional[str] = None,
        timeout: Optional[float] = None,
        cancellation_token: Optional[KavalCancellationToken] = None,
    ) -> Generator[ProductResearchStreamEvent, None, ProductResearchResult]:
        """Stream contiguous canonical progress with the same interruption rules as Offer Search.

        A live stream starts with ``accepted``; a durable same-key replay starts with ``replay``.
        Every ``completed``, ``failed``, or ``cancelled`` terminal carries and returns its exact
        canonical result. Transport and typed SSE errors remain exceptions.
        """
        operation_key = idempotency_key or str(uuid.uuid4())
        request_options: dict[str, Any] = {}
        if timeout is not None:
            request_options["timeout"] = timeout
        if cancellation_token is not None:
            cancellation_token._raise_if_cancelled(operation_key)

        for attempt in range(MAX_BILLABLE_ATTEMPTS):
            response_opened = False
            response: Optional[httpx.Response] = None
            try:

                def send_stream() -> httpx.Response:
                    stream_request = self._http.build_request(
                        "POST",
                        "/v1/product-research",
                        json=dict(request),
                        headers={
                            "accept": "text/event-stream",
                            "idempotency-key": operation_key,
                        },
                        **request_options,
                    )
                    return self._http.send(stream_request, stream=True)

                response = cast(
                    httpx.Response,
                    _run_cancellable(
                        send_stream,
                        cancellation_token,
                        idempotency_key=operation_key,
                        dispose_late=lambda late_response: late_response.close(),
                    ),
                )
                close_response = _once(response.close)
                try:
                    response_opened = True
                    if cancellation_token is not None:
                        cancellation_token._raise_if_cancelled(operation_key)
                    if not 200 <= response.status_code < 300:
                        raw = _run_cancellable(
                            response.read,
                            cancellation_token,
                            idempotency_key=operation_key,
                            on_cancel=close_response,
                        )
                        if cancellation_token is not None:
                            cancellation_token._raise_if_cancelled(operation_key)
                        try:
                            payload: Any = json.loads(raw)
                        except (TypeError, ValueError):
                            payload = raw.decode(errors="replace")
                        if (
                            attempt + 1 < MAX_BILLABLE_ATTEMPTS
                            and _api_error_code(payload) in AMBIGUOUS_IDEMPOTENCY_CODES
                        ):
                            continue
                        raise KavalError(
                            response.status_code,
                            payload,
                            idempotency_key=operation_key,
                        )
                    content_type = response.headers.get("content-type", "")
                    if "text/event-stream" not in content_type.lower():
                        error = TypeError(
                            "Product Research stream returned a non-SSE response"
                        )
                        _attach_idempotency_key(error, operation_key)
                        raise error

                    last_sequence = -1
                    last_observed_at: float | None = None
                    stream_research_id: str | None = None
                    stream_request_digest: str | None = None
                    frame_lines: list[str] = []
                    for line in _iter_lines_cancellable(
                        response,
                        cancellation_token,
                        idempotency_key=operation_key,
                        close_response=close_response,
                    ):
                        if line != "":
                            frame_lines.append(line)
                            continue
                        (
                            event,
                            last_sequence,
                            last_observed_at,
                            stream_research_id,
                            stream_request_digest,
                            final_result,
                            terminal,
                        ) = _parse_product_research_sse_frame(
                            frame_lines,
                            last_sequence=last_sequence,
                            last_observed_at=last_observed_at,
                            idempotency_key=operation_key,
                            expected_query=request["query"],
                            stream_research_id=stream_research_id,
                            stream_request_digest=stream_request_digest,
                        )
                        frame_lines = []
                        if event is not None:
                            if cancellation_token is not None:
                                cancellation_token._raise_if_cancelled(operation_key)
                            yield event
                        if terminal:
                            if cancellation_token is not None:
                                cancellation_token._raise_if_cancelled(operation_key)
                            if final_result is None:
                                raise TypeError(
                                    "Product Research terminal event omitted its canonical result"
                                )
                            return final_result

                    if frame_lines:
                        (
                            event,
                            last_sequence,
                            last_observed_at,
                            stream_research_id,
                            stream_request_digest,
                            final_result,
                            terminal,
                        ) = _parse_product_research_sse_frame(
                            frame_lines,
                            last_sequence=last_sequence,
                            last_observed_at=last_observed_at,
                            idempotency_key=operation_key,
                            expected_query=request["query"],
                            stream_research_id=stream_research_id,
                            stream_request_digest=stream_request_digest,
                        )
                        if event is not None:
                            if cancellation_token is not None:
                                cancellation_token._raise_if_cancelled(operation_key)
                            yield event
                        if terminal:
                            if cancellation_token is not None:
                                cancellation_token._raise_if_cancelled(operation_key)
                            if final_result is None:
                                raise TypeError(
                                    "Product Research terminal event omitted its canonical result"
                                )
                            return final_result

                    error = TypeError(
                        "Product Research stream ended before a canonical terminal event"
                    )
                    _attach_idempotency_key(error, operation_key)
                    raise error
                finally:
                    if cancellation_token is not None and cancellation_token.cancelled:
                        _run_cleanup(close_response)
                    else:
                        _safe_call(close_response)
            except httpx.TransportError as error:
                _attach_idempotency_key(error, operation_key)
                if cancellation_token is not None and cancellation_token.cancelled:
                    cancellation_token._raise_if_cancelled(operation_key)
                if not response_opened and attempt + 1 < MAX_BILLABLE_ATTEMPTS:
                    continue
                raise
        raise RuntimeError("unreachable Product Research stream request state")

    def search_offers(
        self,
        request: OfferSearchInput,
        *,
        idempotency_key: Optional[str] = None,
        timeout: Optional[float] = None,
        cancellation_token: Optional[KavalCancellationToken] = None,
    ) -> LiveOfferSearchResult:
        """Find exact or possible offers through the hosted search surface.

        Current results are research-only and can return only ``NEEDS_REVIEW`` or
        ``NO_RELIABLE_OFFER``. They never authorize a quote or purchase. ``timeout`` is the
        per-call interruption boundary for this synchronous client.
        """
        payload = self._billable_post(
            "/v1/search-offers",
            dict(request),
            idempotency_key=idempotency_key,
            timeout=timeout,
            cancellation_token=cancellation_token,
        )
        return _review_only_offer_search_result(payload, request["request_id"])

    def stream_offer_search(
        self,
        request: OfferSearchInput,
        *,
        idempotency_key: Optional[str] = None,
        timeout: Optional[float] = None,
        cancellation_token: Optional[KavalCancellationToken] = None,
    ) -> Generator[OfferSearchStreamEvent, None, LiveOfferSearchResult]:
        """Stream review-only progress followed by the canonical Offer Search result.

        A transport failure may be retried only before response headers arrive, using the same
        operation key. Once streaming starts, failures surface with that key attached instead of
        replaying partially observed work. Closing the generator closes the HTTP response.
        """
        operation_key = idempotency_key or str(uuid.uuid4())
        request_options: dict[str, Any] = {}
        if timeout is not None:
            request_options["timeout"] = timeout
        if cancellation_token is not None:
            cancellation_token._raise_if_cancelled(operation_key)

        for attempt in range(MAX_BILLABLE_ATTEMPTS):
            response_opened = False
            response: Optional[httpx.Response] = None
            try:

                def send_stream() -> httpx.Response:
                    stream_request = self._http.build_request(
                        "POST",
                        "/v1/search-offers",
                        json=dict(request),
                        headers={
                            "accept": "text/event-stream",
                            "idempotency-key": operation_key,
                        },
                        **request_options,
                    )
                    return self._http.send(stream_request, stream=True)

                response = cast(
                    httpx.Response,
                    _run_cancellable(
                        send_stream,
                        cancellation_token,
                        idempotency_key=operation_key,
                        dispose_late=lambda late_response: late_response.close(),
                    ),
                )
                close_response = _once(response.close)
                try:
                    response_opened = True
                    if cancellation_token is not None:
                        cancellation_token._raise_if_cancelled(operation_key)
                    if not 200 <= response.status_code < 300:
                        raw = _run_cancellable(
                            response.read,
                            cancellation_token,
                            idempotency_key=operation_key,
                            on_cancel=close_response,
                        )
                        if cancellation_token is not None:
                            cancellation_token._raise_if_cancelled(operation_key)
                        try:
                            payload: Any = json.loads(raw)
                        except (TypeError, ValueError):
                            payload = raw.decode(errors="replace")
                        if (
                            attempt + 1 < MAX_BILLABLE_ATTEMPTS
                            and _api_error_code(payload) in AMBIGUOUS_IDEMPOTENCY_CODES
                        ):
                            continue
                        raise KavalError(
                            response.status_code,
                            payload,
                            idempotency_key=operation_key,
                        )

                    content_type = response.headers.get("content-type", "")
                    if "text/event-stream" not in content_type.lower():
                        error = TypeError(
                            "Offer Search stream returned a non-SSE response"
                        )
                        _attach_idempotency_key(error, operation_key)
                        raise error

                    last_sequence = -1
                    stream_request_digest: str | None = None
                    frame_lines: list[str] = []
                    for line in _iter_lines_cancellable(
                        response,
                        cancellation_token,
                        idempotency_key=operation_key,
                        close_response=close_response,
                    ):
                        if line != "":
                            frame_lines.append(line)
                            continue
                        (
                            event,
                            last_sequence,
                            final_result,
                            stream_request_digest,
                        ) = _parse_offer_search_sse_frame(
                            frame_lines,
                            last_sequence=last_sequence,
                            idempotency_key=operation_key,
                            expected_request_id=request["request_id"],
                            stream_request_digest=stream_request_digest,
                        )
                        frame_lines = []
                        if event is not None:
                            if cancellation_token is not None:
                                cancellation_token._raise_if_cancelled(operation_key)
                            yield event
                        if final_result is not None:
                            if cancellation_token is not None:
                                cancellation_token._raise_if_cancelled(operation_key)
                            return final_result

                    if frame_lines:
                        (
                            event,
                            last_sequence,
                            final_result,
                            stream_request_digest,
                        ) = _parse_offer_search_sse_frame(
                            frame_lines,
                            last_sequence=last_sequence,
                            idempotency_key=operation_key,
                            expected_request_id=request["request_id"],
                            stream_request_digest=stream_request_digest,
                        )
                        if event is not None:
                            if cancellation_token is not None:
                                cancellation_token._raise_if_cancelled(operation_key)
                            yield event
                        if final_result is not None:
                            if cancellation_token is not None:
                                cancellation_token._raise_if_cancelled(operation_key)
                            return final_result

                    error = TypeError(
                        "Offer Search stream ended before its final result"
                    )
                    _attach_idempotency_key(error, operation_key)
                    raise error
                finally:
                    if cancellation_token is not None and cancellation_token.cancelled:
                        _run_cleanup(close_response)
                    else:
                        _safe_call(close_response)
            except httpx.TransportError as error:
                _attach_idempotency_key(error, operation_key)
                if cancellation_token is not None and cancellation_token.cancelled:
                    cancellation_token._raise_if_cancelled(operation_key)
                if not response_opened and attempt + 1 < MAX_BILLABLE_ATTEMPTS:
                    continue
                raise
        raise RuntimeError("unreachable Offer Search stream request state")

    def gate_offer_search(
        self,
        request: CommerceActionTimeGateInput,
        *,
        timeout: Optional[float] = None,
        cancellation_token: Optional[KavalCancellationToken] = None,
    ) -> CommerceActionTimeGateResult:
        """Re-read one persisted offer generation at the exact action boundary.

        This final fence always returns ``REVIEW`` with commerce ``permission`` withheld. It never
        authorizes quoting or purchasing, even when the generation is current.
        """
        payload = self._post(
            "/v1/search-offers/gate",
            dict(request),
            timeout=timeout,
            cancellation_token=cancellation_token,
        )
        return _review_only_commerce_action_time_gate_result(payload, request)

    def audit(
        self,
        text: str,
        *,
        as_of: str,
        materiality: Optional[Materiality] = None,
        intended_action: Optional[str] = None,
        reversibility: Optional[ActionReversibility] = None,
        false_allow_cost_usd: Optional[float] = None,
        false_block_cost_usd: Optional[float] = None,
        wait_cost_usd: Optional[float] = None,
        domain: Optional[str] = None,
        subject_hint: Optional[str] = None,
        jurisdiction: Optional[str] = None,
        geography: Optional[str] = None,
        units: Optional[str] = None,
        context: Optional[str] = None,
        aliases: Optional[list[str]] = None,
        origin_urls: Optional[list[str]] = None,
        record: Optional[RecordRef] = None,
        record_field: Optional[str] = None,
        idempotency_key: Optional[str] = None,
        timeout: Optional[float] = None,
    ) -> ProofPacket:
        """Build, sign, and persist a complete action-bound proof packet.

        ``domain`` is descriptive metadata only; it never expands empirical calibration support.
        ``timeout`` overrides the client's default httpx timeout for this call.
        """
        payload = self._billable_post(
            "/v1/audit",
            _clean(
                {
                    "text": text,
                    "as_of": as_of,
                    "materiality": materiality,
                    "intended_action": intended_action,
                    "reversibility": reversibility,
                    "false_allow_cost_usd": false_allow_cost_usd,
                    "false_block_cost_usd": false_block_cost_usd,
                    "wait_cost_usd": wait_cost_usd,
                    "domain": domain,
                    "subject_hint": subject_hint,
                    "jurisdiction": jurisdiction,
                    "geography": geography,
                    "units": units,
                    "context": context,
                    "aliases": aliases,
                    "origin_urls": origin_urls,
                    "record": record,
                    "record_field": record_field,
                }
            ),
            idempotency_key=idempotency_key,
            timeout=timeout,
        )
        return cast(ProofPacket, payload)

    def gate_action(
        self,
        *,
        material_claim_ids: list[str],
        threshold: DecisionThreshold,
        action: ActionContext,
        proof_id: Optional[str] = None,
        proof_key: Optional[str] = None,
        expected_dependency_versions: Optional[dict[str, str]] = None,
        idempotency_key: Optional[str] = None,
        timeout: Optional[float] = None,
    ) -> ProofGateResult:
        """Apply one current durable proof to the exact supplied action without researching again."""
        if (proof_id is None) == (proof_key is None):
            raise ValueError("provide exactly one of proof_id or proof_key")
        payload = self._billable_post(
            "/v1/gate",
            _clean(
                {
                    "proof_id": proof_id,
                    "proof_key": proof_key,
                    "expected_dependency_versions": expected_dependency_versions,
                    "material_claim_ids": material_claim_ids,
                    "threshold": threshold,
                    "action": action,
                }
            ),
            idempotency_key=idempotency_key,
            timeout=timeout,
        )
        return cast(ProofGateResult, payload)

    def gate(self, **kwargs: Any) -> ProofGateResult:
        """Short alias for :meth:`gate_action`."""
        return self.gate_action(**kwargs)

    def report_outcome(
        self, id: str, kind: OutcomeKind, *, note: Optional[str] = None
    ) -> dict[str, Any]:
        return self._post(
            "/v1/report-outcome", _clean({"id": id, "kind": kind, "note": note})
        )

    def kaval(
        self, request: dict[str, Any], *, idempotency_key: Optional[str] = None
    ) -> dict[str, Any]:
        """Lower-level structured passthrough (a KavalRequest)."""
        return self._billable_post(
            "/v1/kaval", request, idempotency_key=idempotency_key
        )

    def kaval_batch(
        self,
        requests: list[dict[str, Any]],
        *,
        concurrency: Optional[int] = None,
        idempotency_key: Optional[str] = None,
    ) -> list[dict[str, Any]]:
        return self._billable_post(
            "/v1/kaval-batch",
            _clean({"requests": requests, "concurrency": concurrency}),
            idempotency_key=idempotency_key,
        )

    def health(self) -> dict[str, Any]:
        res = self._http.get("/health")
        try:
            payload: Any = res.json()
        except ValueError:
            payload = res.text
        if res.status_code >= 400:
            raise KavalError(res.status_code, payload)
        return payload

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> "KavalClient":
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

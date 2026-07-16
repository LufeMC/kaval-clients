"""HTTP client for the kaval REST surface. Mirrors the TS SDK contract."""

from __future__ import annotations

import json
import os
import uuid
from typing import Any, Generator, Literal, Mapping, Optional, cast

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
    if not isinstance(value, str) or not value.startswith("sha256:") or len(value) != 71:
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
            "generation_id" in gate
            and gate["generation_id"] != payload["generation_id"]
        ) or (
            "generation_number" in gate
            and gate["generation_number"] != payload["generation_number"]
        ) or (
            "generation_digest" in gate
            and gate["generation_digest"] != payload["generation_digest"]
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
    if (
        expected_request_id is not None
        and payload["request_id"] != expected_request_id
    ):
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
    if "lifecycle" in payload:
        _validate_commerce_lifecycle(payload["lifecycle"], candidates)
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
            expected_request_id is None
            or payload["request_id"] == expected_request_id
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
            status
            if isinstance(status, int) and not isinstance(status, bool)
            else 500,
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
        event = _review_only_offer_search_replay_event(
            payload, expected_request_id
        )
    else:
        event = _review_only_offer_search_progress_event(payload)
        if event["request_id"] != expected_request_id:
            raise TypeError("Offer Search stream progress request ID is invalid")
    sequence = event["sequence"]
    if (
        event["type"] != event_name
        or (event_sequence is not None and event_sequence != sequence)
    ):
        raise TypeError("Offer Search stream event sequence or type is invalid")
    if sequence <= last_sequence:
        raise TypeError("Offer Search stream sequence is not monotonic")
    if event["type"] == "replay":
        replay_digest = event["request_digest"]
        if (
            stream_request_digest is not None
            and replay_digest != stream_request_digest
        ):
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
        resolved_key = api_key if api_key is not None else os.environ.get("KAVAL_API_KEY")
        headers = {"content-type": "application/json"}
        if resolved_key:
            headers["authorization"] = f"Bearer {resolved_key}"
        self._http = httpx.Client(
            base_url=resolved_base.rstrip("/"),
            headers=headers,
            timeout=timeout,
            transport=transport,
        )

    def _billable_post(
        self,
        path: str,
        body: dict[str, Any],
        *,
        idempotency_key: Optional[str] = None,
        timeout: Optional[float] = None,
    ) -> Any:
        operation_key = idempotency_key or str(uuid.uuid4())
        for attempt in range(MAX_BILLABLE_ATTEMPTS):
            try:
                request_options: dict[str, Any] = {}
                if timeout is not None:
                    request_options["timeout"] = timeout
                res = self._http.post(
                    path,
                    json=body,
                    headers={"idempotency-key": operation_key},
                    **request_options,
                )
            except httpx.TransportError as error:
                _attach_idempotency_key(error, operation_key)
                # The server may have committed before the connection failed. Retry once with the
                # same key so a completed operation is replayed instead of billed twice.
                if attempt + 1 < MAX_BILLABLE_ATTEMPTS:
                    continue
                raise
            try:
                payload: Any = res.json()
            except ValueError as error:
                # Successful responses promise JSON. Preserve that contract instead of returning
                # an unexpected string that callers may treat as a valid verdict. Error responses
                # can come from a proxy as plain text, so retain their body for KavalError.
                if 200 <= res.status_code < 300:
                    _attach_idempotency_key(error, operation_key)
                    raise
                payload = res.text
            if 200 <= res.status_code < 300:
                return payload
            if (
                attempt + 1 < MAX_BILLABLE_ATTEMPTS
                and _api_error_code(payload) in AMBIGUOUS_IDEMPOTENCY_CODES
            ):
                continue
            raise KavalError(res.status_code, payload, idempotency_key=operation_key)
        raise RuntimeError("unreachable billable request state")

    def _post(
        self, path: str, body: dict[str, Any], *, timeout: Optional[float] = None
    ) -> Any:
        request_options: dict[str, Any] = {}
        if timeout is not None:
            request_options["timeout"] = timeout
        res = self._http.post(path, json=body, **request_options)
        try:
            payload: Any = res.json()
        except ValueError:
            payload = res.text
        if res.status_code >= 400:
            raise KavalError(res.status_code, payload)
        return payload

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

    def search_offers(
        self,
        request: OfferSearchInput,
        *,
        idempotency_key: Optional[str] = None,
        timeout: Optional[float] = None,
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
        )
        return _review_only_offer_search_result(payload, request["request_id"])

    def stream_offer_search(
        self,
        request: OfferSearchInput,
        *,
        idempotency_key: Optional[str] = None,
        timeout: Optional[float] = None,
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

        for attempt in range(MAX_BILLABLE_ATTEMPTS):
            response_opened = False
            try:
                with self._http.stream(
                    "POST",
                    "/v1/search-offers",
                    json=dict(request),
                    headers={
                        "accept": "text/event-stream",
                        "idempotency-key": operation_key,
                    },
                    **request_options,
                ) as response:
                    response_opened = True
                    if not 200 <= response.status_code < 300:
                        raw = response.read()
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
                    for line in response.iter_lines():
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
                            yield event
                        if final_result is not None:
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
                            yield event
                        if final_result is not None:
                            return final_result

                    error = TypeError(
                        "Offer Search stream ended before its final result"
                    )
                    _attach_idempotency_key(error, operation_key)
                    raise error
            except httpx.TransportError as error:
                _attach_idempotency_key(error, operation_key)
                if (
                    not response_opened
                    and attempt + 1 < MAX_BILLABLE_ATTEMPTS
                ):
                    continue
                raise
        raise RuntimeError("unreachable Offer Search stream request state")

    def gate_offer_search(
        self,
        request: CommerceActionTimeGateInput,
        *,
        timeout: Optional[float] = None,
    ) -> CommerceActionTimeGateResult:
        """Re-read one persisted offer generation at the exact action boundary.

        This final fence always returns ``REVIEW`` with commerce ``permission`` withheld. It never
        authorizes quoting or purchasing, even when the generation is current.
        """
        payload = self._post(
            "/v1/search-offers/gate",
            dict(request),
            timeout=timeout,
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
        return self._post("/v1/report-outcome", _clean({"id": id, "kind": kind, "note": note}))

    def kaval(
        self, request: dict[str, Any], *, idempotency_key: Optional[str] = None
    ) -> dict[str, Any]:
        """Lower-level structured passthrough (a KavalRequest)."""
        return self._billable_post("/v1/kaval", request, idempotency_key=idempotency_key)

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

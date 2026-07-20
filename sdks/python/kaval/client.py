"""HTTP client for the kaval REST surface. Mirrors the TS SDK contract."""

from __future__ import annotations

from concurrent.futures import CancelledError
import os
from threading import Event, Lock, Thread
import uuid
from typing import (
    Any,
    Callable,
    Literal,
    Mapping,
    Optional,
    Sequence,
    TypeVar,
    cast,
)

import httpx

from .models import (
    ActionContext,
    ActionReversibility,
    DecisionThreshold,
    EvidenceRef,
    Materiality,
    ProofGateResult,
    ProofPacket,
    RecordRef,
    VerifyResult,
)

# One of: current_later_contradicted | stale_caught_real | stale_was_false_alarm | relied_and_correct
OutcomeKind = str

# Speed/depth tier for the legacy belief-freshness surface:
# instant (cache/prior only, no LLM) | fast | auto (default) | deep
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


class KavalProofNotFoundError(KavalError):
    """Raised when `/v1/gate` reports HTTP 404 `proof_not_found`.

    No published proof matched the supplied `proof_id`/`proof_key` in this workspace. Build one
    with :meth:`KavalClient.audit` (or re-check the locator) before gating again.
    """

    code = "proof_not_found"


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


_VERIFY_REQUEST_FIELDS = {
    "conclusion",
    "evidence_refs",
    "as_of",
    "materiality",
    "intended_action",
    "reversibility",
    "jurisdiction",
    "context",
}
_VERIFY_STATUSES = {"valid", "invalidated", "could_not_verify"}
_VERIFY_DECISIONS = {"ALLOW", "BLOCK", "REVIEW"}


def _validated_evidence_refs(evidence_refs: Any) -> list[Any]:
    """Fail fast on the wire contract's sharp edges before spending a billable request.

    Each reference is EITHER a plain URL string OR a strict ``{url, document_id}`` object;
    a bare object without ``document_id`` is invalid, and ``document_id`` values must be
    unique across the request. The server owns URL semantics (https, length bounds).
    """
    if isinstance(evidence_refs, (str, bytes)) or not isinstance(
        evidence_refs, Sequence
    ):
        raise ValueError("evidence_refs must be a list of 1 to 20 evidence references")
    refs = list(evidence_refs)
    if not 1 <= len(refs) <= 20:
        raise ValueError("evidence_refs must contain between 1 and 20 references")
    normalized: list[Any] = []
    document_ids: list[str] = []
    for reference in refs:
        if isinstance(reference, str):
            normalized.append(reference)
            continue
        if isinstance(reference, Mapping):
            if "document_id" not in reference:
                raise ValueError(
                    "an evidence_refs object requires document_id; "
                    "pass a plain URL string instead"
                )
            url = reference.get("url")
            document_id = reference.get("document_id")
            if (
                set(reference.keys()) != {"url", "document_id"}
                or not isinstance(url, str)
                or not isinstance(document_id, str)
                or not document_id
            ):
                raise ValueError(
                    "an evidence_refs object must be exactly "
                    "{url: str, document_id: str}"
                )
            document_ids.append(document_id)
            normalized.append({"url": url, "document_id": document_id})
            continue
        raise ValueError(
            "each evidence reference must be a URL string or {url, document_id}"
        )
    if len(set(document_ids)) != len(document_ids):
        raise ValueError("evidence_refs document_id values must be unique")
    return normalized


def _verify_result(payload: Any) -> VerifyResult:
    """Fail closed if a drifted response could be mistaken for a verification verdict."""
    receipt = payload.get("receipt") if isinstance(payload, dict) else None
    valid = (
        isinstance(payload, dict)
        and payload.get("status") in _VERIFY_STATUSES
        and isinstance(receipt, dict)
        and isinstance(receipt.get("proof_id"), str)
        and bool(receipt["proof_id"])
        and receipt.get("decision") in _VERIFY_DECISIONS
        and isinstance(receipt.get("reason"), str)
        and isinstance(receipt.get("share_endpoint"), str)
        and isinstance(receipt.get("packet"), dict)
    )
    if not valid:
        raise TypeError(
            "verify returned an invalid conclusion-verification envelope; "
            "expected {status, receipt{proof_id, decision, reason, share_endpoint, packet}}"
        )
    return cast(VerifyResult, payload)


class KavalClient:
    """Synchronous client for Kaval's verification surface.

    ``audit()`` builds a signed, time-bounded proof (the expensive path); ``gate()`` applies it
    at act time with no search, parsing, or model call; ``verify()`` is the compatibility surface
    for single conclusions.
    """

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

    def verify(
        self,
        request: Optional[Mapping[str, Any]] = None,
        *,
        conclusion: Optional[str] = None,
        evidence_refs: Optional[Sequence[EvidenceRef]] = None,
        as_of: Optional[str] = None,
        materiality: Optional[Materiality] = None,
        intended_action: Optional[str] = None,
        reversibility: Optional[ActionReversibility] = None,
        jurisdiction: Optional[str] = None,
        context: Optional[str] = None,
        idempotency_key: Optional[str] = None,
        timeout: Optional[float] = None,
        cancellation_token: Optional[KavalCancellationToken] = None,
    ) -> VerifyResult:
        """Verify one load-bearing conclusion against its evidence references.

        Pass either a single request mapping (``verify({"conclusion": ..., "evidence_refs":
        [...]})``) or the same fields as keywords — never both. ``evidence_refs`` holds 1-20
        references; each is a plain https URL string, or a strict ``{url, document_id}`` object
        when the document has a stable caller identity (``document_id`` values must be unique).

        Returns ``{status, receipt}``: ``status`` is ``valid`` | ``invalidated`` |
        ``could_not_verify`` and ``receipt`` is the signed proof receipt (``proof_id``,
        ``decision`` ALLOW/BLOCK/REVIEW, ``reason``, ``share_endpoint``, and the full signed
        ``packet``). Expiry lives at ``receipt["packet"]["action_decision"]["expires_at"]``.

        This is the compatibility surface for single conclusions; production actions should build
        proof with :meth:`audit` and enforce it with :meth:`gate`.
        """
        field_kwargs = {
            "conclusion": conclusion,
            "evidence_refs": evidence_refs,
            "as_of": as_of,
            "materiality": materiality,
            "intended_action": intended_action,
            "reversibility": reversibility,
            "jurisdiction": jurisdiction,
            "context": context,
        }
        if request is not None:
            if any(value is not None for value in field_kwargs.values()):
                raise ValueError(
                    "pass the verify request as one mapping or as keyword fields, not both"
                )
            unknown = set(request.keys()) - _VERIFY_REQUEST_FIELDS
            if unknown:
                raise ValueError(
                    "unknown verify request fields: " + ", ".join(sorted(unknown))
                )
            field_kwargs = {
                name: request.get(name) for name in _VERIFY_REQUEST_FIELDS
            }
        if not isinstance(field_kwargs["conclusion"], str) or not field_kwargs[
            "conclusion"
        ].strip():
            raise ValueError("verify requires a non-empty conclusion string")
        body = _clean(
            {
                "conclusion": field_kwargs["conclusion"],
                "evidence_refs": _validated_evidence_refs(
                    field_kwargs["evidence_refs"]
                ),
                "as_of": field_kwargs["as_of"],
                "materiality": field_kwargs["materiality"],
                "intended_action": field_kwargs["intended_action"],
                "reversibility": field_kwargs["reversibility"],
                "jurisdiction": field_kwargs["jurisdiction"],
                "context": field_kwargs["context"],
            }
        )
        payload = self._billable_post(
            "/v1/verify",
            body,
            idempotency_key=idempotency_key,
            timeout=timeout,
            cancellation_token=cancellation_token,
        )
        return _verify_result(payload)

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
        cancellation_token: Optional[KavalCancellationToken] = None,
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
            cancellation_token=cancellation_token,
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
        """Apply one current durable proof to the exact supplied action without researching again.

        A missing proof surfaces as :class:`KavalProofNotFoundError` (HTTP 404
        ``proof_not_found``), never as a 200 state.
        """
        if (proof_id is None) == (proof_key is None):
            raise ValueError("provide exactly one of proof_id or proof_key")
        try:
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
        except KavalError as error:
            if (
                error.status_code == 404
                and _api_error_code(error.payload) == "proof_not_found"
            ):
                raise KavalProofNotFoundError(
                    error.status_code,
                    error.payload,
                    idempotency_key=error.idempotency_key,
                ) from None
            raise
        return cast(ProofGateResult, payload)

    def gate(self, **kwargs: Any) -> ProofGateResult:
        """Short alias for :meth:`gate_action`."""
        return self.gate_action(**kwargs)

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

    def legacy_verify_belief(
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
        """LEGACY belief-freshness gate (the server still accepts this fallback body).

        Returns the verdict plus ``act`` (True only when current and confident). Treat ``act``
        False as 'do not rely on this belief — re-fetch first'.

        ``mode`` selects a speed/depth tier — instant (cache/prior only, no LLM) | fast | auto
        (default) | deep (full multi-source + a cited explanation). The returned dict echoes
        ``tier``, and on the deep tier adds ``explanation`` {content, citations, confidence}.

        New integrations should use :meth:`verify` (conclusion + evidence_refs) or the full
        :meth:`audit`/:meth:`gate` lifecycle instead.
        """
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
        (default ``fast`` — cheap breadth; re-check a flagged belief at ``deep`` for the cited
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

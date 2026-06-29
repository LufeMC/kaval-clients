"""HTTP client for the kaval REST surface. Mirrors the TS SDK contract."""

from __future__ import annotations

import os
from typing import Any, Literal, Optional

import httpx

# One of: current_later_contradicted | stale_caught_real | stale_was_false_alarm | relied_and_correct
OutcomeKind = str

# Speed/depth tier for verify(): instant (cache/prior only, no LLM) | fast | auto (default) | deep
VerifyMode = Literal["instant", "fast", "auto", "deep"]

# The hosted kaval cloud. Override with `base_url=...` to point at a self-hosted `kaval-server`.
DEFAULT_BASE_URL = "https://api.usekaval.com"


class KavalError(Exception):
    """Raised when the API returns a non-2xx response."""

    def __init__(self, status_code: int, payload: Any) -> None:
        super().__init__(f"kaval {status_code}: {payload}")
        self.status_code = status_code
        self.payload = payload


def _clean(body: dict[str, Any]) -> dict[str, Any]:
    """Drop None-valued keys so optional params are omitted from the request."""
    return {k: v for k, v in body.items() if v is not None}


class KavalClient:
    """Synchronous client: a plain-language belief in, a typed freshness gap out."""

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

    def _post(self, path: str, body: dict[str, Any]) -> Any:
        res = self._http.post(path, json=body)
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
    ) -> dict[str, Any]:
        return self._post(
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
    ) -> dict[str, Any]:
        """Pre-action gate: the verdict plus ``act`` (True only when current and confident).
        Treat ``act`` False as 'do not rely on this belief — re-fetch first'.

        ``mode`` selects a speed/depth tier — instant (cache/prior only, no LLM) | fast | auto
        (default) | deep (full multi-source + a cited explanation). The returned dict echoes
        ``tier``, and on the deep tier adds ``explanation`` {content, citations, confidence}."""
        return self._post(
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
        )

    def extract_and_check(
        self,
        text: str,
        *,
        context: Optional[str] = None,
        freshness_sla: Optional[str] = None,
    ) -> dict[str, Any]:
        return self._post(
            "/v1/extract-and-check",
            _clean({"text": text, "context": context, "freshness_sla": freshness_sla}),
        )

    def scan_store(
        self,
        beliefs: list[str],
        *,
        freshness_sla: Optional[str] = None,
        concurrency: Optional[int] = None,
        mode: Optional[VerifyMode] = None,
    ) -> dict[str, Any]:
        """Sweep a belief store for drift. ``mode`` is the speed/depth tier for the whole sweep
        (default ``fast`` — cheap breadth; re-``verify`` a flagged belief at ``deep`` for the cited
        explanation). The returned dict echoes the ``tier`` the sweep ran at."""
        return self._post(
            "/v1/scan-store",
            _clean(
                {
                    "beliefs": beliefs,
                    "freshness_sla": freshness_sla,
                    "concurrency": concurrency,
                    "mode": mode,
                }
            ),
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
    ) -> dict[str, Any]:
        """Sweep a belief store and POST the NEWLY-risky beliefs to ``webhook`` (server-side delivery).
        Pass the ``state`` from the previous response to deliver only beliefs that became risky since
        then (a still-stale belief isn't re-sent every run). ``mode`` is the sweep tier (default
        ``fast``); the result echoes the ``tier`` it ran at and the ``state`` to carry into the next run."""
        return self._post(
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
        )

    def report_outcome(
        self, id: str, kind: OutcomeKind, *, note: Optional[str] = None
    ) -> dict[str, Any]:
        return self._post("/v1/report-outcome", _clean({"id": id, "kind": kind, "note": note}))

    def kaval(self, request: dict[str, Any]) -> dict[str, Any]:
        """Lower-level structured passthrough (a KavalRequest)."""
        return self._post("/v1/kaval", request)

    def kaval_batch(
        self, requests: list[dict[str, Any]], *, concurrency: Optional[int] = None
    ) -> list[dict[str, Any]]:
        return self._post(
            "/v1/kaval-batch", _clean({"requests": requests, "concurrency": concurrency})
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

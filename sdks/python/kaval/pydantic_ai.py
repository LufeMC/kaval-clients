"""Pydantic AI guardrail adapter — gate agent outputs on belief freshness.

One line wires Kaval into a Pydantic AI agent as an output validator: every factual claim the
agent is about to return is re-derived from the live world, and a stale / contradicted /
unsupported belief raises ``ModelRetry`` with the engine's evidence-backed reason — so the model
re-answers with the correction in context instead of shipping the stale fact. This is
verify-and-auto-refresh: Pydantic AI's retry loop IS the refresh.

Usage (the whole integration)::

    from pydantic_ai import Agent
    from kaval.pydantic_ai import verify_output

    agent = Agent("openai:gpt-5")
    agent.output_validator(verify_output())

Requires the ``pydantic-ai`` extra: ``pip install "kaval[pydantic-ai]"``.
"""

from __future__ import annotations

import asyncio
from typing import Any, Callable, Optional, Sequence, TypeVar

from .client import KavalClient, VerifyMode

OutputT = TypeVar("OutputT")

# Keep one retry's verification spend bounded even if the extractor finds many claims.
_MAX_BELIEFS = 10


def _default_beliefs(client: KavalClient, output: Any) -> list[str]:
    """Extract checkable claims from a plain-text output via the API's extractor."""
    if not isinstance(output, str):
        raise TypeError(
            "kaval.pydantic_ai.verify_output: pass beliefs=... to extract claims from a "
            f"structured output (got {type(output).__name__})"
        )
    extracted = client.extract_and_check(output)
    return [b.get("belief", "") for b in extracted.get("beliefs", [])]


def _gaps_of(verdicts: list[dict[str, Any]]) -> list[str]:
    """One retry-prompt line per belief that is NOT safe to rely on."""
    lines: list[str] = []
    for v in verdicts:
        if v.get("act") is True or v.get("status") == "current":
            continue
        belief = v.get("belief") or v.get("_belief") or "(belief)"
        reason = v.get("reason", "could not be verified")
        sources = ", ".join(
            e.get("url", "") for e in v.get("evidence", [])[:2] if e.get("url")
        )
        lines.append(
            f'- "{belief}" is {v.get("status", "unverified")}: {reason}'
            + (f" (see {sources})" if sources else "")
        )
    return lines


def verify_output(
    client: Optional[KavalClient] = None,
    *,
    beliefs: Optional[Callable[[Any], Sequence[str]]] = None,
    mode: VerifyMode = "fast",
    min_confidence: Optional[float] = None,
    freshness_sla: Optional[str] = None,
) -> Callable[[OutputT], Any]:
    """Build a Pydantic AI output validator that verifies the output's beliefs before returning.

    Args:
        client: A configured :class:`KavalClient`. Defaults to one built from ``KAVAL_API_KEY``.
        beliefs: Extracts the belief strings to verify from the agent's output. Defaults to
            Kaval's own claim extractor over a plain-text output; REQUIRED for structured outputs
            (e.g. ``lambda out: [out.claim]``).
        mode: Verify tier per belief (default ``fast`` — the cheap production gate).
        min_confidence: Act only at/above this confidence (engine default 0.7).
        freshness_sla: How current ground truth must be, e.g. ``"14d"``.

    Returns:
        An async ``(ctx, output)`` validator for ``agent.output_validator(...)``. It returns the
        output unchanged when every belief verifies ``current``, and raises
        ``pydantic_ai.ModelRetry`` listing each stale/contradicted/unsupported belief (with the
        engine's reason + evidence URLs) otherwise. Streamed partial outputs are passed through
        unverified — only the complete output is gated.
    """
    try:
        from pydantic_ai import ModelRetry
    except ImportError as e:  # pragma: no cover - exercised only without the extra
        raise ImportError(
            'kaval.pydantic_ai requires pydantic-ai: pip install "kaval[pydantic-ai]"'
        ) from e

    kv = client or KavalClient()

    def _verify_all(output: Any) -> list[str]:
        claims = list(beliefs(output)) if beliefs else _default_beliefs(kv, output)
        claims = [c for c in claims if isinstance(c, str) and c.strip()][:_MAX_BELIEFS]
        verdicts: list[dict[str, Any]] = []
        for claim in claims:
            v = kv.verify(
                claim,
                mode=mode,
                min_confidence=min_confidence,
                freshness_sla=freshness_sla,
            )
            v["_belief"] = claim
            verdicts.append(v)
        return _gaps_of(verdicts)

    async def _validator(ctx: Any, output: OutputT) -> OutputT:
        # During streamed runs validators also fire on partial chunks; verifying those would
        # spend money on half-sentences, so only the final output is gated.
        if getattr(ctx, "partial_output", False):
            return output
        # The sync client blocks on HTTP; keep the agent's event loop free while it verifies.
        gaps = await asyncio.to_thread(_verify_all, output)
        if gaps:
            raise ModelRetry(
                "Some facts in your answer are stale or unverifiable against live sources. "
                "Correct them using the findings below, or state that you could not verify them:\n"
                + "\n".join(gaps)
            )
        return output

    return _validator

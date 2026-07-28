"""Pydantic AI guardrail adapter — gate agent outputs on Kaval's ALLOW / REVIEW / BLOCK verdict.

One line wires Kaval into a Pydantic AI agent as an output validator: before the agent's answer
leaves the run, :meth:`kaval.KavalClient.check` verifies the facts it depends on, and anything
other than **ALLOW** raises ``ModelRetry`` with the changed/unknown facts and their sources — so
the model re-answers with the correction in context instead of shipping the stale fact. This is
verify-and-auto-refresh: Pydantic AI's retry loop IS the refresh.

Only ALLOW means "safe to act". REVIEW is never permission, so the guardrail retries on it too.

Usage (the whole integration)::

    from pydantic_ai import Agent
    from kaval.pydantic_ai import verify_output

    agent = Agent("openai:gpt-5")
    agent.output_validator(verify_output())

Requires the ``pydantic-ai`` extra: ``pip install "kaval[pydantic-ai]"``.
"""

from __future__ import annotations

import asyncio
from typing import Any, Awaitable, Callable, Optional, Sequence, TypeVar

from .client import KavalClient
from .models import CheckMode, ClaimInput, Materiality

OutputT = TypeVar("OutputT")

# The server's own request bounds (`apps/server/src/check/contracts.ts`). An oversized body is a
# 400, and a 400 raised inside an output validator is a KavalError that ends the run instead of a
# ModelRetry that fixes it — so anything past these bounds is turned into a retry here, before the
# request. They are NOT trimmed to fit: a silently dropped claim is an UNCHECKED claim, and an
# unchecked claim reads as ALLOW, which is the one outcome this guardrail exists to prevent.
_MAX_CLAIMS = 20
_MAX_ACTION_CHARS = 10_000
_MAX_CLAIM_CHARS = 2_000


def _gaps_of(result: dict[str, Any]) -> list[str]:
    """One retry-prompt line per fact that does not still hold."""
    lines: list[str] = []
    for fact in result.get("facts", []):
        if fact.get("status") == "holds":
            continue
        sources = ", ".join(
            source.get("locator", "")
            for source in fact.get("sources", [])[:2]
            if source.get("locator")
        )
        lines.append(
            f'- "{fact.get("text", "(fact)")}" is {fact.get("status", "unverified")}'
            + (f" (see {sources})" if sources else "")
        )
    if not lines:
        # A verdict can turn on compilation uncertainty or an unreachable source with no
        # per-fact row to point at; never raise ModelRetry with an empty body.
        lines.append(
            "- the claims in this answer could not be confirmed against current sources"
        )
    return lines


def verify_output(
    client: Optional[KavalClient] = None,
    *,
    claims: Optional[Callable[[Any], Sequence[ClaimInput]]] = None,
    mode: Optional[CheckMode] = None,
    materiality: Optional[Materiality] = None,
    max_wait_ms: Optional[int] = None,
    context: Optional[str] = None,
) -> Callable[[Any, OutputT], Awaitable[OutputT]]:
    """Build a Pydantic AI output validator that checks the output's facts before returning it.

    Args:
        client: A configured :class:`KavalClient`. Defaults to one built from ``KAVAL_API_KEY``.
        claims: Extracts the claims to check from the agent's output (plain sentences or
            structured claims). Defaults to sending the whole plain-text output as the ``action``
            so Kaval compiles the facts itself; REQUIRED for structured outputs (e.g.
            ``lambda out: [out.claim]``).
        mode: ``fast`` answers from stored fact state only; ``standard`` (server default) allows
            the bounded live fallback.
        materiality: Declared materiality for the whole check (``low|medium|high|critical``).
        max_wait_ms: Live-path budget in ms. Facts that miss it come back ``unknown``.
        context: Anything the agent already knows that bears on the answer.

    Returns:
        An async ``(ctx, output)`` validator for ``agent.output_validator(...)``. It returns the
        output unchanged on **ALLOW**, and raises ``pydantic_ai.ModelRetry`` on REVIEW or BLOCK,
        listing the decision, its reason codes, and each changed/unknown fact with its sources.
        An answer too big for one check (over 10 000 characters, more than 20 claims, or a single
        claim over 2 000 characters) raises ``ModelRetry`` as well — it cannot be verified as
        written, and this guardrail never lets an unverified answer through as ALLOW.
        Streamed partial outputs are passed through unchecked — only the complete output is gated.
    """
    try:
        from pydantic_ai import ModelRetry
    except ImportError as e:  # pragma: no cover - exercised only without the extra
        raise ImportError(
            'kaval.pydantic_ai requires pydantic-ai: pip install "kaval[pydantic-ai]"'
        ) from e

    kv = client or KavalClient()

    def _check(output: Any) -> dict[str, Any]:
        if claims is not None:
            selected = [claim for claim in claims(output) if claim]
            if len(selected) > _MAX_CLAIMS:
                raise ModelRetry(
                    f"Kaval verifies at most {_MAX_CLAIMS} claims per check and this answer "
                    f"yielded {len(selected)}. Say only the claims the answer actually rests on, "
                    "or state fewer, larger ones."
                )
            oversized = next(
                (
                    claim
                    for claim in selected
                    if isinstance(claim, str) and len(claim) > _MAX_CLAIM_CHARS
                ),
                None,
            )
            if oversized is not None:
                raise ModelRetry(
                    f"A claim in this answer is {len(oversized)} characters; Kaval verifies claims "
                    f"of at most {_MAX_CLAIM_CHARS}. Split it into separate, single-fact claims."
                )
            return dict(
                kv.check(
                    claims=selected,
                    context=context,
                    mode=mode,
                    materiality=materiality,
                    max_wait_ms=max_wait_ms,
                )
            )
        if not isinstance(output, str):
            raise TypeError(
                "kaval.pydantic_ai.verify_output: pass claims=... to check a "
                f"structured output (got {type(output).__name__})"
            )
        if len(output) > _MAX_ACTION_CHARS:
            raise ModelRetry(
                f"This answer is {len(output)} characters and Kaval verifies at most "
                f"{_MAX_ACTION_CHARS}, so none of it could be checked. Answer more briefly, or "
                "state only the load-bearing facts."
            )
        return dict(
            kv.check(
                action=output,
                context=context,
                mode=mode,
                materiality=materiality,
                max_wait_ms=max_wait_ms,
            )
        )

    async def _validator(ctx: Any, output: OutputT) -> OutputT:
        # During streamed runs validators also fire on partial chunks; checking those would
        # spend a call on half-sentences, so only the final output is gated.
        if getattr(ctx, "partial_output", False):
            return output
        # The sync client blocks on HTTP; keep the agent's event loop free while it checks.
        result = await asyncio.to_thread(_check, output)
        if result.get("decision") != "ALLOW":
            reasons = ", ".join(result.get("reason_codes", [])) or "no reason code"
            raise ModelRetry(
                f"Kaval returned {result.get('decision', 'REVIEW')} ({reasons}): some facts in "
                "your answer no longer hold against current sources. Correct them using the "
                "findings below, or state that you could not verify them:\n"
                + "\n".join(_gaps_of(result))
            )
        return output

    return _validator

"""Hermetic tests for the Pydantic AI guardrail adapter.

pydantic-ai is a heavy optional extra, so when it isn't installed these tests inject a minimal
stand-in module exposing ``ModelRetry`` — the only symbol the adapter imports. When the real
package IS installed (CI with the extra, see test_pydantic_ai_agent.py), it is used as-is.
The Kaval side always runs on httpx.MockTransport (no network)."""

import asyncio
import json
import sys
import types

import httpx
import pytest

try:
    from pydantic_ai import ModelRetry
except ImportError:  # no extra installed — stub the one symbol the adapter imports
    _stub = types.ModuleType("pydantic_ai")

    class ModelRetry(Exception):  # type: ignore[no-redef]
        pass

    _stub.ModelRetry = ModelRetry
    sys.modules["pydantic_ai"] = _stub

from kaval import KavalClient  # noqa: E402
from kaval.pydantic_ai import verify_output  # noqa: E402

CURRENT = {
    "id": "id_1",
    "status": "current",
    "confidence": 0.95,
    "reason": "confirmed",
    "evidence": [],
    "checked_at": "2026-07-01T00:00:00.000Z",
    "act": True,
}

STALE = {
    "id": "id_2",
    "status": "stale",
    "confidence": 0.9,
    "reason": "the team page changed",
    "evidence": [{"url": "http://acme.test/team"}],
    "checked_at": "2026-07-01T00:00:00.000Z",
    "act": False,
}


def make_client(handler):
    return KavalClient(base_url="http://test", transport=httpx.MockTransport(handler))


def run(coro):
    return asyncio.run(coro)


class Ctx:
    """Minimal RunContext stand-in — the adapter only reads .partial_output."""

    def __init__(self, partial_output: bool = False) -> None:
        self.partial_output = partial_output


def test_current_beliefs_pass_through_unchanged():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/verify"
        return httpx.Response(200, json=CURRENT)

    with make_client(handler) as c:
        validator = verify_output(c, beliefs=lambda out: [out])
        assert run(validator(Ctx(), "Jane Doe is the CEO of Acme")) == "Jane Doe is the CEO of Acme"


def test_stale_belief_raises_model_retry_with_reason_and_source():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=STALE)

    with make_client(handler) as c:
        validator = verify_output(c, beliefs=lambda out: [out])
        with pytest.raises(ModelRetry) as exc:
            run(validator(Ctx(), "Jane Doe is the CEO of Acme"))

    msg = str(exc.value)
    assert "stale" in msg
    assert "the team page changed" in msg
    assert "http://acme.test/team" in msg


def test_default_extractor_uses_extract_and_check():
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.path)
        if request.url.path == "/v1/extract-and-check":
            return httpx.Response(
                200, json={"beliefs": [{**STALE, "belief": "Acme HQ is in Austin"}]}
            )
        return httpx.Response(200, json=STALE)

    with make_client(handler) as c:
        validator = verify_output(c)
        with pytest.raises(ModelRetry) as exc:
            run(validator(Ctx(), "Acme HQ is in Austin and the sky is blue."))

    assert calls[0] == "/v1/extract-and-check"
    assert "/v1/verify" in calls[1:]
    assert "Acme HQ is in Austin" in str(exc.value)


def test_structured_output_without_beliefs_extractor_is_a_type_error():
    with make_client(lambda r: httpx.Response(200, json=CURRENT)) as c:
        validator = verify_output(c)
        with pytest.raises(TypeError, match="beliefs="):
            run(validator(Ctx(), {"claim": "structured"}))


def test_partial_streamed_output_is_not_verified():
    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError("no HTTP call expected for partial output")

    with make_client(handler) as c:
        validator = verify_output(c, beliefs=lambda out: [out])
        out = run(validator(Ctx(partial_output=True), "half a sent"))
    assert out == "half a sent"


def test_verify_carries_mode_and_options():
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json=CURRENT)

    with make_client(handler) as c:
        validator = verify_output(
            c, beliefs=lambda out: [out], mode="deep", min_confidence=0.8, freshness_sla="14d"
        )
        run(validator(Ctx(), "a belief"))

    assert captured["body"]["mode"] == "deep"
    assert captured["body"]["minConfidence"] == 0.8
    assert captured["body"]["freshness_sla"] == "14d"


def test_belief_cap_limits_verify_calls():
    verify_calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        verify_calls.append(json.loads(request.content)["belief"])
        return httpx.Response(200, json=CURRENT)

    with make_client(handler) as c:
        validator = verify_output(c, beliefs=lambda out: [f"claim {i}" for i in range(25)])
        run(validator(Ctx(), "anything"))

    assert len(verify_calls) == 10  # _MAX_BELIEFS

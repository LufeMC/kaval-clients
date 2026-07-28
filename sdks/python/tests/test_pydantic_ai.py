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

RECEIPT = {"id": "rcpt_1", "signature": "c2ln", "signed_at": "2026-07-26T00:00:00.000Z"}
LATENCY = {"compile": 1, "lookup": 8, "live": 0, "total": 11}

ALLOW = {
    "decision": "ALLOW",
    "reason_codes": ["ALL_FACTS_HOLD"],
    "facts": [
        {
            "fingerprint": "fact:sha256:1",
            "text": "Jane Doe is the CEO of Acme",
            "status": "holds",
            "materiality": "high",
            "served_from_state": True,
            "last_verified_at": "2026-07-25T09:00:00.000Z",
            "sources": [{"locator": "http://acme.test/team"}],
        }
    ],
    "receipt": RECEIPT,
    "latency_ms": LATENCY,
}

BLOCK = {
    "decision": "BLOCK",
    "reason_codes": ["FACT_CHANGED"],
    "facts": [
        {
            "fingerprint": "fact:sha256:2",
            "text": "Jane Doe is the CEO of Acme",
            "status": "changed",
            "materiality": "critical",
            "served_from_state": True,
            "last_verified_at": "2026-07-25T09:00:00.000Z",
            "sources": [{"locator": "http://acme.test/team"}],
        }
    ],
    "receipt": RECEIPT,
    "latency_ms": LATENCY,
}


def make_client(handler):
    return KavalClient(base_url="http://test", transport=httpx.MockTransport(handler))


def run(coro):
    return asyncio.run(coro)


class Ctx:
    """Minimal RunContext stand-in — the adapter only reads .partial_output."""

    def __init__(self, partial_output: bool = False) -> None:
        self.partial_output = partial_output


def test_allow_passes_the_output_through_unchanged():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/check"
        return httpx.Response(200, json=ALLOW)

    with make_client(handler) as c:
        validator = verify_output(c, claims=lambda out: [out])
        assert run(validator(Ctx(), "Jane Doe is the CEO of Acme")) == (
            "Jane Doe is the CEO of Acme"
        )


def test_block_raises_model_retry_with_the_decision_reason_and_source():
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=BLOCK)

    with make_client(handler) as c:
        validator = verify_output(c, claims=lambda out: [out])
        with pytest.raises(ModelRetry) as exc:
            run(validator(Ctx(), "Jane Doe is the CEO of Acme"))

    msg = str(exc.value)
    assert "BLOCK" in msg
    assert "FACT_CHANGED" in msg
    assert "changed" in msg
    assert "http://acme.test/team" in msg


def test_review_is_never_permission_to_act():
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                **BLOCK,
                "decision": "REVIEW",
                "reason_codes": ["FACT_UNKNOWN"],
                "facts": [{**BLOCK["facts"][0], "status": "unknown"}],
            },
        )

    with make_client(handler) as c:
        validator = verify_output(c, claims=lambda out: [out])
        with pytest.raises(ModelRetry, match="REVIEW"):
            run(validator(Ctx(), "Jane Doe is the CEO of Acme"))


def test_a_verdict_with_no_failing_fact_row_still_names_a_gap():
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                **ALLOW,
                "decision": "REVIEW",
                "reason_codes": ["COMPILATION_UNCERTAIN"],
                "facts": [],
            },
        )

    with make_client(handler) as c:
        validator = verify_output(c, claims=lambda out: [out])
        with pytest.raises(ModelRetry) as exc:
            run(validator(Ctx(), "something ambiguous"))

    assert "could not be confirmed" in str(exc.value)


def test_default_path_sends_the_whole_output_as_the_action():
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/check"
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json=ALLOW)

    with make_client(handler) as c:
        validator = verify_output(c)
        run(validator(Ctx(), "Acme HQ is in Austin and the sky is blue."))

    # No claims extractor: Kaval compiles the facts out of the output itself.
    assert captured["body"] == {"action": "Acme HQ is in Austin and the sky is blue."}


def test_structured_output_without_a_claims_extractor_is_a_type_error():
    with make_client(lambda r: httpx.Response(200, json=ALLOW)) as c:
        validator = verify_output(c)
        with pytest.raises(TypeError, match="claims="):
            run(validator(Ctx(), {"claim": "structured"}))


def test_partial_streamed_output_is_not_checked():
    def handler(_request: httpx.Request) -> httpx.Response:
        raise AssertionError("no HTTP call expected for partial output")

    with make_client(handler) as c:
        validator = verify_output(c, claims=lambda out: [out])
        out = run(validator(Ctx(partial_output=True), "half a sent"))
    assert out == "half a sent"


def test_check_carries_mode_and_options():
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json=ALLOW)

    with make_client(handler) as c:
        validator = verify_output(
            c,
            claims=lambda out: [out],
            mode="fast",
            materiality="critical",
            max_wait_ms=1500,
            context="procurement gate",
        )
        run(validator(Ctx(), "a claim"))

    assert captured["body"] == {
        "claims": ["a claim"],
        "context": "procurement gate",
        "mode": "fast",
        "materiality": "critical",
        "max_wait_ms": 1500,
    }


def test_claims_up_to_the_server_maximum_go_out_in_one_call():
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured.setdefault("calls", 0)
        captured["calls"] += 1
        captured["claims"] = json.loads(request.content)["claims"]
        return httpx.Response(200, json=ALLOW)

    with make_client(handler) as c:
        validator = verify_output(c, claims=lambda out: [f"claim {i}" for i in range(20)])
        run(validator(Ctx(), "anything"))

    assert captured["calls"] == 1
    assert len(captured["claims"]) == 20  # _MAX_CLAIMS


def test_more_claims_than_one_check_carries_is_a_retry_not_a_silent_drop():
    def handler(_request: httpx.Request) -> httpx.Response:
        raise AssertionError("a body the server would reject must not be sent")

    with make_client(handler) as c:
        validator = verify_output(c, claims=lambda out: [f"claim {i}" for i in range(25)])
        with pytest.raises(ModelRetry) as exc:
            run(validator(Ctx(), "anything"))

    # Claim 21 used to be sliced off and never checked — and an unchecked claim reads as ALLOW.
    assert "25" in str(exc.value)
    assert "20" in str(exc.value)


def test_an_output_past_the_action_limit_is_a_retry_not_a_dead_run():
    def handler(_request: httpx.Request) -> httpx.Response:
        raise AssertionError("a body the server would reject must not be sent")

    long_answer = "The tariff rate is 7.5 percent. " * 400  # >10_000 characters
    assert len(long_answer) > 10_000

    with make_client(handler) as c:
        validator = verify_output(c)
        with pytest.raises(ModelRetry) as exc:
            run(validator(Ctx(), long_answer))

    # Previously a 400 that escaped the validator as a raw KavalError and ended the run.
    assert str(len(long_answer)) in str(exc.value)


def test_a_claim_past_the_claim_limit_is_a_retry_too():
    def handler(_request: httpx.Request) -> httpx.Response:
        raise AssertionError("a body the server would reject must not be sent")

    with make_client(handler) as c:
        validator = verify_output(c, claims=lambda out: ["x" * 2_001])
        with pytest.raises(ModelRetry, match="2001"):
            run(validator(Ctx(), "anything"))

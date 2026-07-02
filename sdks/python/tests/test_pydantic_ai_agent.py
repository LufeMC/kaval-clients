"""End-to-end test of the guardrail against the REAL pydantic-ai package: a real Agent run where
the model first answers with a stale fact, Kaval (on httpx.MockTransport — no network) flags it,
ModelRetry sends the evidence back, and the model corrects itself on the retry.

Skipped automatically when the pydantic-ai extra isn't installed."""

import json

import httpx
import pytest

pydantic_ai = pytest.importorskip("pydantic_ai")
if not hasattr(pydantic_ai, "Agent"):
    # test_pydantic_ai.py stubs the module when the extra isn't installed; the stub only carries
    # ModelRetry, so a missing Agent means "real package not available" -> skip the e2e tests.
    pytest.skip("pydantic-ai extra not installed", allow_module_level=True)

from pydantic_ai import Agent  # noqa: E402
from pydantic_ai.messages import ModelMessage, ModelResponse, RetryPromptPart, TextPart  # noqa: E402
from pydantic_ai.models.function import AgentInfo, FunctionModel  # noqa: E402

from kaval import KavalClient  # noqa: E402
from kaval.pydantic_ai import verify_output  # noqa: E402

STALE_ANSWER = "Steve Ballmer is the CEO of Microsoft."
FRESH_ANSWER = "Satya Nadella is the CEO of Microsoft."


def make_model(seen_retry_prompts: list[str]) -> FunctionModel:
    """A model that answers with the stale fact until it receives a retry prompt."""

    def respond(messages: list[ModelMessage], _info: AgentInfo) -> ModelResponse:
        for message in messages:
            for part in getattr(message, "parts", []):
                if isinstance(part, RetryPromptPart):
                    seen_retry_prompts.append(part.model_response())
        answer = FRESH_ANSWER if seen_retry_prompts else STALE_ANSWER
        return ModelResponse(parts=[TextPart(answer)])

    return FunctionModel(respond)


def make_kaval() -> tuple[KavalClient, list[str]]:
    """Kaval on a mock transport: 'Ballmer' verifies stale, anything else current."""
    verified: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/verify"
        belief = json.loads(request.content)["belief"]
        verified.append(belief)
        if "Ballmer" in belief:
            return httpx.Response(
                200,
                json={
                    "id": "id_stale",
                    "status": "stale",
                    "confidence": 0.93,
                    "reason": "Satya Nadella has been Microsoft's CEO since 2014",
                    "evidence": [{"url": "https://microsoft.test/leadership"}],
                    "checked_at": "2026-07-01T00:00:00.000Z",
                    "act": False,
                },
            )
        return httpx.Response(
            200,
            json={
                "id": "id_ok",
                "status": "current",
                "confidence": 0.95,
                "reason": "confirmed",
                "evidence": [],
                "checked_at": "2026-07-01T00:00:00.000Z",
                "act": True,
            },
        )

    return KavalClient(base_url="http://test", transport=httpx.MockTransport(handler)), verified


def test_agent_retries_stale_fact_and_returns_fresh_answer():
    retry_prompts: list[str] = []
    client, verified = make_kaval()
    agent = Agent(make_model(retry_prompts))
    agent.output_validator(verify_output(client, beliefs=lambda out: [out]))

    result = agent.run_sync("Who is the CEO of Microsoft?")

    # The stale first answer was verified, rejected, and regenerated fresh.
    assert result.output == FRESH_ANSWER
    assert verified == [STALE_ANSWER, FRESH_ANSWER]
    # The retry prompt carried the engine's reason + evidence URL back to the model.
    assert len(retry_prompts) == 1
    assert "Satya Nadella has been Microsoft's CEO since 2014" in retry_prompts[0]
    assert "https://microsoft.test/leadership" in retry_prompts[0]


def test_agent_passes_through_when_current():
    retry_prompts: list[str] = []
    client, verified = make_kaval()
    agent = Agent(make_model(retry_prompts))

    # Model answers fresh from the start (no retry prompt ever seen -> STALE first). Force a
    # fresh-only model instead:
    def always_fresh(_messages: list[ModelMessage], _info: AgentInfo) -> ModelResponse:
        return ModelResponse(parts=[TextPart(FRESH_ANSWER)])

    agent = Agent(FunctionModel(always_fresh))
    agent.output_validator(verify_output(client, beliefs=lambda out: [out]))

    result = agent.run_sync("Who is the CEO of Microsoft?")
    assert result.output == FRESH_ANSWER
    assert verified == [FRESH_ANSWER]
    assert retry_prompts == []


def test_agent_exhausts_retry_budget_when_always_stale():
    from pydantic_ai.exceptions import UnexpectedModelBehavior

    client, _ = make_kaval()

    def always_stale(_messages: list[ModelMessage], _info: AgentInfo) -> ModelResponse:
        return ModelResponse(parts=[TextPart(STALE_ANSWER)])

    agent = Agent(FunctionModel(always_stale))
    agent.output_validator(verify_output(client, beliefs=lambda out: [out]))

    # A model that never corrects itself burns the output-retry budget and surfaces loudly —
    # the agent does NOT silently return the stale fact.
    with pytest.raises(UnexpectedModelBehavior):
        agent.run_sync("Who is the CEO of Microsoft?")

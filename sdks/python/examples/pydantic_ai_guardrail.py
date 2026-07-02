# Kaval as a Pydantic AI output guardrail — the whole integration is one line (line 12).
# Any factual claim the agent is about to return gets verified against the live world;
# a stale/contradicted fact raises ModelRetry with evidence, and the model corrects itself.
#
#   pip install "kaval[pydantic-ai]"
#   export KAVAL_API_KEY=kv_live_...  OPENAI_API_KEY=sk-...
from pydantic_ai import Agent

from kaval.pydantic_ai import verify_output

agent = Agent("openai:gpt-5", system_prompt="Answer from your own knowledge. Be concrete.")
agent.output_validator(verify_output())  # <- the guardrail

result = agent.run_sync("Who is the CEO of OpenAI, and what does the company sell?")
print(result.output)
# If the model answers from a stale weight ("…the CEO is X"), Kaval verifies against live
# sources, the validator raises ModelRetry with the correction + citations, and the agent
# re-answers with the current fact — verify-and-auto-refresh, no orchestration code.

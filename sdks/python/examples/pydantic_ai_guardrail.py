# Kaval as a Pydantic AI output guardrail — the whole integration is one line (line 12).
# Before the agent's answer leaves the run, check() verifies the facts it depends on;
# anything other than ALLOW raises ModelRetry with the evidence, and the model corrects itself.
#
#   pip install "kaval[pydantic-ai]"
#   export KAVAL_API_KEY=kv_live_...  OPENAI_API_KEY=sk-...
from pydantic_ai import Agent

from kaval.pydantic_ai import verify_output

agent = Agent("openai:gpt-5", system_prompt="Answer from your own knowledge. Be concrete.")
agent.output_validator(verify_output())  # <- the guardrail

result = agent.run_sync("Who is the CEO of OpenAI, and what does the company sell?")
print(result.output)
# If the model answers from a stale weight ("…the CEO is X"), Kaval checks the facts against
# watched-source state (falling back to bounded live research), the validator raises ModelRetry
# with the changed facts + their sources, and the agent re-answers with the current fact —
# verify-and-auto-refresh, no orchestration code. Only ALLOW passes; REVIEW is never permission.

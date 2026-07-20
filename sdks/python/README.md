# kaval (Python SDK)

Before an AI agent acts, Kaval verifies the facts the action relies on and returns a time-bounded
signed proof your policy can enforce — `ALLOW`, `REVIEW`, or `BLOCK`.

`audit()` builds the proof (the expensive path); `gate()` applies it at act time with no search,
parsing, or model call; `verify()` is the compatibility surface for single conclusions.

Policy engines decide whether an action is permitted under the rules; Kaval verifies whether the
facts those rules depend on are still true.

## Install

```bash
pip install kaval
```

## Verify one conclusion against its evidence

```python
from kaval import KavalClient

with KavalClient(api_key="kv_live_...") as kaval:
    result = kaval.verify({
        "conclusion": "The 2024 International Building Code is the current IBC edition.",
        "evidence_refs": ["https://codes.iccsafe.org/content/IBC2024V2.0"],
    })
    if result["status"] != "valid":
        hold_workflow(result)
    save_receipt(result["receipt"])
```

The same fields also work as keywords: `kaval.verify(conclusion=..., evidence_refs=[...])`.
`evidence_refs` holds 1–20 references. Each is a plain **https URL string**, or a strict
`{"url": ..., "document_id": ...}` object when the document has a stable identity you will refer
to again (a bare object without `document_id` is invalid — use the plain string form instead;
`document_id` values must be unique). Optional fields: `as_of` (RFC 3339 with offset),
`materiality` (`low|medium|high|critical`), `intended_action`, `reversibility`
(`reversible|partially_reversible|irreversible|unknown`), `jurisdiction`, `context`.

The response is `{status, receipt}`:

- `status` — `valid` | `invalidated` | `could_not_verify`.
- `receipt` — the signed proof receipt: `proof_id`, `decision` (`ALLOW`/`BLOCK`/`REVIEW`),
  `reason`, `share_endpoint` (`/v1/proofs/<id>/share`), and the full signed `packet`. There is no
  receipt-level `expires_at` — expiry lives at `receipt["packet"]["action_decision"]["expires_at"]`.

Receipts are Ed25519-signed (`packet["signature"]` with a key id like `proof-ed25519-2026-07`).
Anyone can verify one offline with the open verifier (`@kaval/receipt-verifier` in the main repo)
against `GET /v1/proof-verification-keys/:kid`.

## Build a proof, then gate the action

```python
from datetime import datetime, timezone
from kaval import KavalClient, KavalProofNotFoundError

with KavalClient(api_key="kv_live_...") as client:
    proof = client.audit(
        "Acme is eligible for a $12,000 refund",
        as_of=datetime.now(timezone.utc).isoformat(),
        intended_action="Issue Acme a $12,000 refund",
        materiality="critical",
        reversibility="irreversible",
        false_allow_cost_usd=12_000,
        record={"system": "billing", "table": "refunds", "id": "acme-2026"},
        timeout=45.0,
    )
    try:
        gate = client.gate(
            proof_id=proof["proof_id"],
            material_claim_ids=proof["action_decision"]["material_claim_ids"],
            threshold=proof["action_decision"]["threshold"],
            action=proof["research_contract"]["action"],
        )
    except KavalProofNotFoundError:
        # HTTP 404 proof_not_found: no published proof matched this locator — rebuild with audit().
        raise
    if not (gate["state"] == "current" and gate["decision"]["decision"] == "ALLOW"):
        raise RuntimeError("Kaval did not allow the action")
```

`audit()` returns the raw signed `ProofPacket` — claims (`claim_dag`), sources
(`source_versions`), evidence spans and assessments, the `action_decision`
(`decision`, `summary`, `expires_at`), `expiry` (`recheck_at`, `expires_at`,
`invalidation_triggers`), and the Ed25519 `signature`.

`gate()` (alias `gate_action()`) takes exactly one of `proof_id` | `proof_key`, plus
`material_claim_ids`, `threshold` (`policy_id`, `policy_version`, `materiality`,
`maximum_false_allow_risk`, `minimum_evidence_coverage`), `action` (`description`, `materiality`,
`reversibility?`, cost fields), and optional `expected_dependency_versions`. It returns
`{proofId, state, decision, billingClass, proofReused, researchPerformed: False,
humanOverrideApplied?, latencyMs}` where `state` is
`current | not_yet_valid | expired | invalidated | dependency_changed | integrity_failed |
policy_mismatch | operational_failure`. A missing proof is never a 200 — it surfaces as
`KavalProofNotFoundError` (HTTP 404, error code `proof_not_found`).

**Honest boundaries.** Demo results carry no organizational authority. A production `ALLOW`
requires a customer-bound action policy and applicable empirical calibration; `REVIEW` is never
permission.

## Async / concurrency

**Sync-only for now.** `KavalClient` is built on `httpx.Client` (blocking I/O) and does not yet ship
an `AsyncKavalClient`. If you need `async`/`await`, call the REST API with `httpx.AsyncClient`, wrap
sync calls in `asyncio.to_thread()`, or use the Node SDK (`@usekaval/kaval`). Native async may land
in a later release.

## Caller cancellation

`verify()` and `audit()` accept a thread-safe, one-shot cancellation token:

```python
from threading import Timer
from kaval import KavalCancellationToken, KavalCancelledError, KavalClient

token = KavalCancellationToken()
timer = Timer(2.0, lambda: token.cancel("request no longer needed"))
timer.start()
try:
    with KavalClient(api_key="kv_live_...") as client:
        result = client.verify(
            conclusion="The 2024 International Building Code is the current IBC edition.",
            evidence_refs=["https://codes.iccsafe.org/content/IBC2024V2.0"],
            idempotency_key="your-stable-operation-id",
            cancellation_token=token,
        )
except KavalCancelledError as error:
    # Billable calls retain their recovery key.
    recoverable_operation_key = error.idempotency_key
finally:
    timer.cancel()
```

A token cancelled before call entry performs no HTTP request. In flight, cancellation releases the
blocked caller, never triggers the SDK's bounded retry, and requests best-effort closure of an open
or later-arriving response. The first `cancel(reason)` wins, and its reason is available on
`KavalCancelledError`.

The synchronous httpx public API has no portable hard-abort equivalent to JavaScript `AbortSignal`
for blocking I/O. Kaval uses only the public `Response.close()` cleanup API; depending on the
platform and transport phase, a daemon worker may remain until the underlying I/O returns or its
configured `timeout=` expires. Keep a finite timeout as the transport-level cleanup backstop.

## Legacy held-belief compatibility

The original belief-freshness surface remains available under an explicitly legacy name (the server
still accepts this fallback body on the same route):

```python
from kaval import KavalClient

with KavalClient(api_key="kv_live_...") as client:
    decision = client.legacy_verify_belief("Acme's CEO is Jane Doe")
    if not decision["act"]:
        ...  # stale / contradicted — re-fetch before relying on it
```

`legacy_verify_belief()` returns the verdict plus `act` — `True` only when the belief is `current`
and confident (≥ 0.7 by default; override with `min_confidence`). `mode` selects a tier (default
`auto`): `instant` (cache / graph-prior only, no fetch or LLM), `fast` (cheap model, origin-only),
`auto` (balanced), or `deep` (strongest model + a cited explanation). The returned dict echoes
`tier`, and on the `deep` tier adds `explanation` (`content`, `citations`, `confidence`).

The related legacy belief methods — `check`, `extract_and_check`, `scan_store`, `monitor`,
`kaval`, `kaval_batch`, `report_outcome` — keep working unchanged:

```python
beliefs = ["Acme is on the Enterprise plan", "Jane Doe is VP Eng at Acme"]

report = client.scan_store(beliefs)
for r in report["riskiest"]:
    print(r["belief"], "→", r["status"])

# …or get pushed the newly-stale ones (carry `state` across runs so a still-stale belief
# isn't re-delivered every sweep):
client.monitor(beliefs, webhook="https://your-app.com/hooks/stale")
```

## Pydantic AI guardrail (one line)

Gate a [Pydantic AI](https://ai.pydantic.dev) agent's outputs on belief freshness (this adapter
rides the legacy compatibility surface). Facts the agent is about to return are verified against
the live world; a stale / contradicted / unsupported claim raises `ModelRetry` with the
evidence-backed correction, and the agent re-answers with the current fact:

```python
# pip install "kaval[pydantic-ai]"
from pydantic_ai import Agent
from kaval.pydantic_ai import verify_output

agent = Agent("openai:gpt-5")
agent.output_validator(verify_output())  # <- the guardrail
```

By default plain-text outputs go through Kaval's claim extractor (`extract_and_check`). For
structured outputs, say which fields are checkable beliefs:

```python
agent.output_validator(
    verify_output(beliefs=lambda out: [f"{out.company}'s CEO is {out.ceo}"], mode="fast")
)
```

`verify_output(...)` also takes `client=` (a configured `KavalClient`), `min_confidence=`, and
`freshness_sla=` (e.g. `"14d"`). Streaming runs are supported — partial chunks pass through and
only the complete output is verified. Each retry consumes the run's output-retry budget
(`Agent(retries={"output": N})`). Full runnable example: `examples/pydantic_ai_guardrail.py`.

## Custom base URL

Override the API base URL (e.g. a staging environment or a local proxy):

```python
client = KavalClient(base_url="https://staging.api.usekaval.com", api_key="...")
```

## Environment variables

When omitted, constructor args fall back to:

| Variable         | Used for     | Default                    |
| ---------------- | ------------ | -------------------------- |
| `KAVAL_API_KEY`  | Bearer token | none (unauthenticated)     |
| `KAVAL_BASE_URL` | API origin   | `https://api.usekaval.com` |

Explicit `api_key=` / `base_url=` always wins over the environment.

## Resilience

Each billable call automatically sends a fresh UUID `Idempotency-Key`. The client performs one
safety retry only after an ambiguous `httpx.TransportError`, or when the API says the same operation
is still in progress/finalizing; that retry reuses the exact key. Ordinary API errors, rate limits,
and terminal 5xx responses are not retried.

Pass `idempotency_key=` when an outer job/retry system needs to keep one logical operation stable:

```python
import uuid

operation_id = str(uuid.uuid4())
result = client.verify(
    conclusion="The 2024 International Building Code is the current IBC edition.",
    evidence_refs=["https://codes.iccsafe.org/content/IBC2024V2.0"],
    idempotency_key=operation_id,
)
```

Reuse a key only after an ambiguous/no-response failure. After receiving a terminal response, start
a new key for any new attempt. `report_outcome()` and `health()` are not billable and do not send this
header. Add your own retry/backoff for terminal responses when appropriate.
If both bounded attempts remain ambiguous, `KavalError` and `httpx.TransportError` expose the
generated key as `error.idempotency_key`; pass it back after your own delay to resume the same
operation rather than generating and billing a new one.

**Default timeout: 30 seconds** (connect + read), overridable at construction:

```python
# audit proof-building may run close to the limit — raise for long-running calls:
client = KavalClient(api_key="...", timeout=60.0)
```

Timeouts surface as `httpx.TimeoutException` (not `KavalError`).

## API

`verify` · `audit` · `gate` (`gate_action` alias) · `legacy_verify_belief` · `check` ·
`extract_and_check` · `scan_store` · `monitor` · `report_outcome` · `kaval` · `kaval_batch` ·
`health`. Billable methods accept the optional keyword `idempotency_key=`. Construct with
`KavalClient(base_url=?, api_key=?)` — `base_url` defaults to `https://api.usekaval.com`. The
Node/TypeScript client mirrors this surface: `npm install @usekaval/kaval`.

## Test

```bash
pip install -e ".[dev]"            # from sdks/python (development)
pytest                             # hermetic contract tests (httpx MockTransport)
KAVAL_BASE_URL=https://api.usekaval.com KAVAL_API_KEY=kv_live_... pytest   # also runs the live test
```

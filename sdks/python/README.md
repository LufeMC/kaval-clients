# kaval (Python SDK)

The evidence gate for AI agents. Before an agent acts, Kaval checks that the current evidence still
supports that exact action. The full proof lifecycle returns `ALLOW`, `REVIEW`, or `BLOCK`; when the
evidence changes or expires, the permission does too.

**Search retrieves evidence. Kaval decides whether that evidence is sufficient for the action.**

## Install

```bash
pip install kaval
```

## Async / concurrency

**Sync-only for now.** `KavalClient` is built on `httpx.Client` (blocking I/O) and does not yet ship
an `AsyncKavalClient`. If you need `async`/`await`, call the REST API with `httpx.AsyncClient`, wrap
sync calls in `asyncio.to_thread()`, or use the Node SDK (`@usekaval/kaval`). Native async may land
in a later release. `stream_product_research()` and `stream_offer_search()` are progressive but
still synchronous.

## Caller cancellation

Product Research and Offer Search accept a thread-safe, one-shot cancellation token:

```python
from threading import Timer
from kaval import KavalCancellationToken, KavalCancelledError, KavalClient

token = KavalCancellationToken()
timer = Timer(2.0, lambda: token.cancel("request no longer needed"))
timer.start()
try:
    with KavalClient(api_key="kv_live_...") as client:
        result = client.search_offers(
            offer_request,
            idempotency_key="your-stable-operation-id",
            cancellation_token=token,
        )
except KavalCancelledError as error:
    # Billable Product/Offer calls and streams retain their recovery key.
    recoverable_operation_key = error.idempotency_key
finally:
    timer.cancel()
```

Pass `cancellation_token=` to `research_products()`, `stream_product_research()`,
`search_offers()`, `stream_offer_search()`, or `gate_offer_search()`. A token cancelled before
iteration/call entry performs no HTTP request. In flight, cancellation releases the blocked caller,
never triggers the SDK's bounded retry, and requests best-effort closure of an open or
later-arriving response. A cancelled live stream releases its blocked consumer immediately and
requests response-body closure. The first `cancel(reason)` wins, and its reason is available on
`KavalCancelledError`.

The synchronous httpx public API has no portable hard-abort equivalent to JavaScript `AbortSignal`
for blocking I/O. Kaval uses only the public `Response.close()` cleanup API; depending on the
platform and transport phase, a daemon worker may remain until the underlying I/O returns or its
configured `timeout=` expires. This can occur before response headers and when another thread is
blocked reading a live response. Keep a finite timeout as the transport-level cleanup backstop.

## Research products from ordinary text (review-only)

```python
from kaval import KavalClient, ProductResearchInput

request: ProductResearchInput = {
    "query": "cordless framing nailer",
    "market": {"country_code": "US", "preferred_currency": "USD"},
    "filters": {"condition": "new", "listing_kinds": ["purchase"]},
}

with KavalClient(api_key="kv_live_...") as client:
    result = client.research_products(request)
    stream = client.stream_product_research(request)
    try:
        for event in stream:
            if event["type"] == "group_updated":
                render_group(event["group"])
            elif event["type"] == "completed":
                result = event["result"]
    finally:
        stream.close()
```

Execution limits are server-owned and intentionally absent from `ProductResearchInput`. JSON may
return a canonical complete, partial, failed, or cancelled result. SSE sequences are contiguous and
zero-based, start with `accepted`, and terminate with `completed`, `failed`, or `cancelled`; durable
same-key replay is explicit. Every terminal carries its exact canonical result, which the generator
returns for completed, failed, and cancelled outcomes; genuine transport and typed SSE errors still
raise. Response shape, timestamps, request binding, and review-only authority are validated before
exposure. `authority["permission"]` is always `"withheld"` and never authorizes an action. Both
methods support `idempotency_key=`, `timeout=`, and `cancellation_token=`; closing or cancelling
early requests best-effort response closure, with the finite timeout bounding any blocking sync
transport read that cannot be interrupted.
Verified offers and candidate progress also fail closed unless every published material field has a
unique exact evidence binding to the same tier, origin URL, observation, and receipt; merchant
hostnames and listing-specific price semantics must match.

## Find current offer evidence (review-only)

```python
from kaval import KavalClient, OfferSearchInput

# This typed request contains the exact product identifiers/attributes, destination, policies,
# intended action, freshness requirement, and bounded search budget.
offer_request: OfferSearchInput = load_offer_request()

with KavalClient(api_key="kv_live_...") as client:
    result = client.search_offers(
        offer_request,
        idempotency_key="your-stable-operation-id",
        timeout=20.0,
    )
    if result["action"]["state"] == "NEEDS_REVIEW":
        queue_for_human_review(result["candidates"])

    # When durable lifecycle metadata is present, final-fence the exact generation at action time.
    lifecycle = result.get("lifecycle")
    if lifecycle and lifecycle["persistence"] == "persisted":
        final_fence = client.gate_offer_search(
            {
                "dependency_id": lifecycle["dependency_id"],
                "generation_id": lifecycle["generation_id"],
                "generation_number": lifecycle["generation_number"],
                "generation_digest": lifecycle["generation_digest"],
                "action_binding": lifecycle["action_binding"],
            },
            timeout=5.0,
        )
        if final_fence["state"] != "current_review_only":
            refresh_offer_evidence(lifecycle["dependency_id"])
        # disposition is REVIEW and permission is withheld in every state.
```

For live progress, use the synchronous SSE generator. Every progress event is validated as
`research_only` / `REVIEW`, sequences must increase, and the terminal `final` event contains the
same canonical `LiveOfferSearchResult` returned by `search_offers()`:

```python
stream = client.stream_offer_search(
    offer_request,
    idempotency_key="your-stable-operation-id",
    timeout=20.0,
)
try:
    for event in stream:
        if event["type"] == "candidate_provisional":
            # Display-only: durable=False, actionable=False, permission="withheld".
            render_provisional_offer(event["details"]["candidate"])
        elif event["type"] == "final":
            result = event["result"]
        elif event["type"] == "replay":
            note("The same operation key replayed completed work.")
        else:
            show_progress(event["message"], event["details"])
finally:
    # A normal completed loop is already closed. When stopping early, close() requests response
    # cleanup; use a finite timeout to bound any sync transport read that cannot be interrupted.
    stream.close()
```

`candidate_provisional` is the only pre-completion candidate event. Its typed details always state
`publication_state == "provisional"`, `durable is False`, `actionable is False`,
`permission == "withheld"`, and `final_inclusion == "not_yet_determined"`. The client binds its
request ID and cryptographic digest across provisional, replay, and terminal results and rejects
drift. The later `candidate` event has crossed the current final publication boundary; only the exact
`lifecycle["selected_candidate_id"]` is durable, and every candidate remains review-only.

The client retries once with the same operation key only if the transport fails before stream
headers arrive (or the API reports that the same operation is still being resolved). It never
retries after a stream has begun or after caller cancellation. If a later read is interrupted or the
stream ends before `final`, the exception carries `idempotency_key` for an explicit same-key
recovery attempt.

Offer Search researches permitted, accessible configured sources: structured catalogs and merchant
feeds, retailer/search workers, direct origin re-fetches, serialized browser DOM when needed, and
destination-aware checkout resolvers. Its explicit acquisition ledger reports the sources it did
not or could not search; it does not claim exhaustive coverage of the entire internet. Its typed
`LiveOfferSearchResult` is deliberately shadow-grade:
`action.state` is `NEEDS_REVIEW` or `NO_RELIABLE_OFFER`, candidate dispositions are `review` or
`rejected`, and the SDK rejects any drifted response that claims `ALLOW`, `BLOCK`,
`SAFE_TO_QUOTE`, or other commerce authority. Do not quote or purchase from this result without
review.

New runtime results can include `candidate["checkout"]`, which records destination eligibility,
availability, seller authorization, item/shipping/tax/fees, declared and calculated landed totals,
expiry, resolver version, cost, and operational gaps. `result["acquisition"]` records the bounded
source plan and full `source_ledger`, including sources that succeeded, failed, were prohibited,
were deferred, or remained unsearched. These fields make coverage limits visible; they do not turn
the review-only result into permission.

When the server has a durable commerce lifecycle configured, `result["lifecycle"]` identifies the
immutable evidence generation, exact selected candidate, and action binding. Call
`gate_offer_search()` immediately before the action boundary. It re-reads that generation and the
latest stream head, but deliberately returns only `disposition: "REVIEW"` and
`permission: "withheld"`; stale, expired, invalidated, changed, revoked, unavailable, or mismatched
evidence must be refreshed or reviewed.

## Legacy held-belief compatibility

```python
from kaval import KavalClient

# Explicit config (always works):
with KavalClient(api_key="kv_live_...") as client:
    decision = client.verify("Acme's CEO is Jane Doe")
    if not decision["act"]:
        ...  # stale / contradicted — re-fetch before relying on it

# Or set env vars and construct with no args (see below):
# export KAVAL_API_KEY=kv_live_...
# export KAVAL_BASE_URL=https://api.usekaval.com   # optional; defaults to prod
with KavalClient() as client:
    ...
```

`verify()` preserves the original currentness API. It returns the verdict plus `act` — `True` only
when the belief is `current` and confident
(≥ 0.7 by default; override with `min_confidence`).

## Build a proof, then gate the action

```python
from datetime import datetime, timezone
from kaval import KavalClient

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
    gate = client.gate_action(
        proof_id=proof["proof_id"],
        material_claim_ids=proof["action_decision"]["material_claim_ids"],
        threshold=proof["action_decision"]["threshold"],
        action=proof["research_contract"]["action"],
    )
    enforcement = gate.get("enforcement")
    if enforcement is not None and enforcement["controlApplied"]:
        if enforcement["executionAllowed"] is not True:
            raise RuntimeError("Kaval blocked the action")
    elif enforcement is None and not (
        gate["state"] == "current" and gate["decision"]["decision"] == "ALLOW"
    ):
        # A direct integration without staged enforcement fails closed.
        raise RuntimeError("Kaval did not allow the action")
    # controlApplied == False is shadow mode: record wouldAllow, but keep the customer's
    # existing action policy authoritative.
```

The package exports the primary request/response `TypedDict` models, `KavalCancellationToken`, and
`KavalCancelledError` at top level; `kaval.models` provides every nested proof object. Only an
enforcement result with `controlApplied == True` controls execution. Shadow mode returns
`controlApplied == False`, `executionAllowed is None`, and `wouldAllow` for calibration.

### Pick a speed/depth tier

`verify(belief, mode=...)` selects a tier (default `auto`): `instant` (cache / graph-prior only, no
fetch or LLM), `fast` (cheap model, origin-only), `auto` (balanced), or `deep` (strongest model + a
cited explanation). The returned dict echoes `tier`, and on the `deep` tier adds `explanation`:

```python
gap = client.verify("Acme's CEO is Jane Doe", mode="deep")
gap["tier"]                       # "deep"
gap["explanation"]["content"]     # markdown rationale with [n] citations (deep only)
gap["explanation"]["citations"]   # [{"url": ..., "title"?: ...}] — only from gathered evidence
gap["explanation"]["confidence"]  # "high" | "medium" | "low"
```

### Sweep a store for drift

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

Gate a [Pydantic AI](https://ai.pydantic.dev) agent's outputs on belief freshness. Facts the agent
is about to return are verified against the live world; a stale / contradicted / unsupported claim
raises `ModelRetry` with the evidence-backed correction, and the agent re-answers with the current
fact — verify-and-auto-refresh, no orchestration code:

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

The marketing site (`apps/web`) uses **`KAVAL_API_URL`** for its server-side proxy — not
`KAVAL_BASE_URL`. Set both when self-hosting the engine and running the web demo against it.

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
decision = client.verify("Acme's CEO is Jane Doe", idempotency_key=operation_id)
```

Reuse a key only after an ambiguous/no-response failure. After receiving a terminal response, start
a new key for any new attempt. `report_outcome()` and `health()` are not billable and do not send this
header. Add your own retry/backoff for terminal responses when appropriate.
If both bounded attempts remain ambiguous, `KavalError` and `httpx.TransportError` expose the
generated key as `error.idempotency_key`; pass it back after your own delay to resume the same
operation rather than generating and billing a new one.

**Default timeout: 30 seconds** (connect + read), overridable at construction:

```python
# deep verify / scan sweeps may run close to the limit — raise for long-running calls:
client = KavalClient(api_key="...", timeout=60.0)
```

Timeouts surface as `httpx.TimeoutException` (not `KavalError`).

## API

`research_products` · `stream_product_research` · `search_offers` · `stream_offer_search` · `gate_offer_search` · `audit` · `gate_action` (`gate` alias) · `verify` · `check` · `extract_and_check` · `scan_store` ·
`monitor` · `report_outcome` · `kaval` · `kaval_batch` · `health`. Billable methods accept the
optional keyword `idempotency_key=`. Construct with `KavalClient(base_url=?, api_key=?)` —
`base_url` defaults to `https://api.usekaval.com`. The Node/TypeScript client mirrors this surface:
`npm install @usekaval/kaval`.

## Test

```bash
pip install -e ".[dev]"            # from sdks/python (development)
pytest                             # hermetic contract tests (httpx MockTransport)
KAVAL_BASE_URL=https://api.usekaval.com KAVAL_API_KEY=kv_live_... pytest   # also runs the live test
```

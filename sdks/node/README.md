# @usekaval/kaval

The evidence gate for AI agents. Before an agent acts, Kaval checks that the current evidence still
supports that exact action. The full proof lifecycle returns `ALLOW`, `REVIEW`, or `BLOCK`; when the
evidence changes or expires, the permission does too.

**Search retrieves evidence. Kaval decides whether that evidence is sufficient for the action.**

```bash
npm install @usekaval/kaval
```

## Node and module format

This package is **ESM-first** (`"type": "module"`). Use `import` in ESM projects, or dynamic import
in CommonJS:

```js
const { Kaval } = await import("@usekaval/kaval");
```

**CJS `require("@usekaval/kaval")`** needs Node **≥20.19** or **≥22.12** (Node’s native
`require(esm)` support). On Node 18, use `import` / `await import()` instead — `engines.node` is
`>=18` for ESM + `fetch`, not for CJS require.

## Find current offer evidence (review-only)

```ts
import { Kaval, type OfferSearchInput } from "@usekaval/kaval";

const request: OfferSearchInput = {
  schema_revision: 1,
  request_id: crypto.randomUUID(),
  raw_description: "Makita XPH14Z hammer drill, tool only",
  target: {
    schema_revision: 1,
    name: "Makita XPH14Z",
    identifiers: [{ scheme: "model", value: "XPH14Z" }],
    attributes: [{ key: "kit", value: false }],
  },
  requested_condition: "new",
  destination: { country_code: "US", region: "CA", postal_code: "94107" },
  match_policy: {
    identity_requirement: "shared_identifier",
    required_identifier_schemes: ["model"],
    required_attribute_keys: ["kit"],
    permitted_substitutions: [],
  },
  seller_policy: {
    allowed_seller_ids: [],
    blocked_seller_ids: [],
    allowed_kinds: ["brand_direct", "authorized_retailer"],
    require_authorized: true,
  },
  destination_policy: {
    require_eligible: true,
    require_exact_region: true,
    require_exact_postal_code: true,
  },
  price_policy: {
    currency: "USD",
    require_complete_landed_total: true,
    allow_estimated_components: false,
    allow_member_price: false,
    allow_subscription_price: false,
    allow_coupon_price: false,
    allow_installment_display: false,
    allow_trade_in_price: false,
  },
  source_policy: {
    allowed_source_ids: [],
    blocked_source_ids: [],
    require_origin_evidence: true,
  },
  intended_action: {
    description: "Quote this exact item to a customer",
    materiality: "high",
    reversibility: "partially_reversible",
  },
  freshness_maximum_age_ms: 300_000,
  max_results: 5,
  minimum_unique_sellers: 2,
  deadline_ms: 15_000,
  maximum_cost_micro_usd: 50_000,
  maximum_search_calls: 4,
  maximum_fetches: 12,
};

const kaval = new Kaval({
  apiKey: process.env.KAVAL_API_KEY,
});
const result = await kaval.searchOffers(request);

if (result.action.state === "NEEDS_REVIEW") {
  await queueForHumanReview(result.candidates);
}

// When durable lifecycle metadata is present, final-fence the exact generation at action time.
// Even current evidence remains REVIEW-only until commerce authorization is calibrated.
if (result.lifecycle?.persistence === "persisted") {
  const finalFence = await kaval.gateOfferSearch({
    dependency_id: result.lifecycle.dependency_id,
    generation_id: result.lifecycle.generation_id,
    generation_number: result.lifecycle.generation_number,
    generation_digest: result.lifecycle.generation_digest,
    action_binding: result.lifecycle.action_binding,
  });
  if (finalFence.state !== "current_review_only") {
    await refreshOfferEvidence(result.lifecycle.dependency_id);
  }
  // finalFence.disposition === "REVIEW" and finalFence.permission === "withheld" in every state.
}
```

For progressive UI or agent feedback, consume the same operation as SSE. The last event contains the
same guarded result returned by `searchOffers()`; earlier events are explicitly `research_only` and
cannot authorize a quote or purchase:

```ts
for await (const event of kaval.streamOfferSearch(request, {
  idempotencyKey: crypto.randomUUID(),
})) {
  if (event.type === "candidate_provisional") {
    // Origin verification finished, but final selection and lifecycle persistence have not.
    // durable=false, actionable=false, permission="withheld".
    renderProvisionalOffer(event.details.candidate);
  } else if (event.type === "final") {
    await queueForHumanReview(event.result.candidates);
  } else {
    console.log(
      event.type,
      event.type === "replay" ? "completed operation replayed" : event.message,
    );
  }
}
```

`candidate_provisional` is the only pre-completion candidate event. Its typed details always state
`publication_state: "provisional"`, `durable: false`, `actionable: false`,
`permission: "withheld"`, and `final_inclusion: "not_yet_determined"`. The SDK binds its request
ID and cryptographic digest across provisional, replay, and terminal results and rejects drift. The
later `candidate` event has crossed the current final publication boundary; only the exact
`lifecycle.selected_candidate_id` is durable, and every candidate remains review-only.

Offer Search researches the accessible configured web through configured structured source workers,
search discovery, direct origin re-fetches, serialized-DOM browser fallback, and optional
destination-aware checkout resolution. `candidate.checkout` contains the checkout receipt when one
was verified; `acquisition.source_ledger` states which planned sources succeeded, failed, were
prohibited, or remained unsearched. Coverage is explicitly bounded, not a claim to have searched the
literal entire internet. Its public output is deliberately shadow-grade: `action.state` is
`NEEDS_REVIEW` or `NO_RELIABLE_OFFER`, candidate dispositions are `review` or `rejected`, and the
SDK rejects any drifted response that claims `ALLOW`, `BLOCK`, `SAFE_TO_QUOTE`, or other commerce
authority. Do not quote or purchase from this result without review. `searchOffers()` accepts the same
`{ idempotencyKey?, signal?, timeoutMs? }` request options as other billable calls;
`streamOfferSearch()` also closes the response stream when its signal is aborted or iteration stops.

When the server has a durable commerce lifecycle configured, `result.lifecycle` identifies the
immutable evidence generation, exact selected candidate, and action binding. Call
`gateOfferSearch()` immediately before the action boundary. It re-reads that generation and the
latest stream head, but deliberately returns only `disposition: "REVIEW"` and
`permission: "withheld"`; stale, expired, invalidated, changed, revoked, unavailable, or mismatched
evidence must be refreshed or reviewed.

## Build a proof, then gate the action

```ts
import { Kaval } from "@usekaval/kaval";

const kaval = new Kaval({ apiKey: process.env.KAVAL_API_KEY });
const proof = await kaval.audit({
  text: "Acme is eligible for a $12,000 refund",
  as_of: new Date().toISOString(),
  intended_action: "Issue Acme a $12,000 refund",
  materiality: "critical",
  reversibility: "irreversible",
  false_allow_cost_usd: 12_000,
  record: { system: "billing", table: "refunds", id: "acme-2026" },
});
const gate = await kaval.gateAction({
  proof_id: proof.proof_id,
  material_claim_ids: proof.action_decision.material_claim_ids,
  threshold: proof.action_decision.threshold,
  action: proof.research_contract.action,
});
if (gate.enforcement?.controlApplied === true) {
  if (gate.enforcement.executionAllowed !== true) {
    throw new Error("Kaval blocked the action");
  }
} else if (
  gate.enforcement === undefined &&
  (gate.state !== "current" || gate.decision.decision !== "ALLOW")
) {
  // A direct integration without staged enforcement fails closed.
  throw new Error("Kaval did not allow the action");
}
// controlApplied === false is shadow mode: record wouldAllow, but keep the customer's existing
// action policy authoritative.
```

`audit()` returns the complete typed `ProofPacket`: atomic claims, policy bindings, immutable source
versions, exact evidence spans, lineage families, claim assessments, calibrated/withheld risk,
provenance, expiry, and signature. `gateAction()` is the cheap action-time check and includes staged
`enforcement` (`shadow`, `block_only`, or `bounded`) when configured by the deployment.
Only `enforcement.controlApplied === true` may control execution. Shadow mode returns
`controlApplied: false`, `executionAllowed: null`, and a counterfactual `wouldAllow` for calibration.

Both methods accept `{ idempotencyKey?, signal?, timeoutMs? }`. The constructor defaults to a
30-second deadline; override per call or set `timeoutMs: null` to disable it. Cancellation and timeout
errors retain `error.idempotencyKey`, because an interrupted billable request can be ambiguous.

## Legacy held-belief compatibility

```ts
import { Kaval } from "@usekaval/kaval";

const kaval = new Kaval({ apiKey: process.env.KAVAL_API_KEY });

const decision = await kaval.verify("Acme's CEO is Jane Doe");
if (!decision.act) {
  // stale / contradicted — re-fetch before relying on it
}
```

`verify()` preserves the original currentness API. It returns the verdict plus `act` — `true` only
when the belief is `current` and confident
(≥ 0.7 by default; override with `minConfidence`).

## Safe retries and idempotency

Every billable call automatically sends a fresh UUID `Idempotency-Key`. If the connection fails
without a trustworthy response, or the API says the operation is still being finalized, the client
retries once with the same key. It does not retry ordinary API errors, rate limits, or terminal 5xx
responses.

Pass your own key when an outer job/retry system needs to keep one logical operation stable:

```ts
const operationId = crypto.randomUUID();
const decision = await kaval.verify(
  { belief: "Acme's CEO is Jane Doe" },
  { idempotencyKey: operationId },
);
```

Reuse a key only after an ambiguous/no-response failure. After receiving a terminal response, start
a new key for any new attempt. `reportOutcome()` and `health()` are not billable and do not send this
header. If both bounded attempts remain ambiguous, the thrown `KavalError` or transport error exposes
the generated key as `error.idempotencyKey`; pass it back explicitly after your own delay to resume
the same operation instead of starting and billing a new one.

## Pick a speed/depth tier

```ts
const decision = await kaval.verify({
  belief: "Acme's CEO is Jane Doe",
  mode: "deep",
});

decision.tier; // "deep" — the tier that ran (echoes your `mode`)
decision.explanation?.content; // deep only: a cited, markdown rationale with [n] citations
decision.explanation?.citations; // [{ url, title? }] — drawn only from the gathered evidence
decision.explanation?.confidence; // "high" | "medium" | "low"
```

`mode` selects the tier (default `auto`):

- **`instant`** — cache / graph-prior only, no fetch or LLM; fastest, answers from what's already known.
- **`fast`** — a cheap model, origin-only.
- **`auto`** — balanced (the default).
- **`deep`** — the strongest model + a synthesized, inline-cited `explanation` for audit/human review.

## Sweep a store for drift

```ts
const report = await kaval.scanStore({
  beliefs: ["Acme is on the Enterprise plan", "Jane Doe is VP Eng at Acme"],
});
report.riskiest.forEach((r) => console.log(r.belief, "→", r.status));

// …or get pushed the newly-stale ones:
await kaval.monitor({ beliefs, webhook: "https://your-app.com/hooks/stale" });
```

## API

`searchOffers` · `streamOfferSearch` · `gateOfferSearch` · `audit` · `gateAction` (`gate` alias) · `verify` · `check` · `extractAndCheck` · `scanStore` ·
`monitor` · `reportOutcome` · `kaval` · `kavalBatch` · `health`. Billable methods accept a final
`{ idempotencyKey?, signal?, timeoutMs? }` request-options argument (`kavalBatch` includes it alongside
`concurrency`). Construct with `{ apiKey, baseUrl?, fetch?, timeoutMs? }` — `baseUrl` defaults to
`https://api.usekaval.com`. Works in Node 18+, browsers, and edge runtimes (uses the global `fetch`).

**Env vars:** this package does **not** read `KAVAL_BASE_URL` from the environment — pass
`baseUrl` in the constructor (Python SDK and MCP use `KAVAL_BASE_URL`; the marketing-site proxy
uses `KAVAL_API_URL`). See the [clients README](../README.md#api-origin-env-vars).

The Python client mirrors this surface: `pip install kaval`.

# @usekaval/kaval

The freshness gate for AI. Give kaval a belief your system already holds — a cached fact, a CRM
field, an agent memory — and it checks the live world and returns a typed verdict: `current`,
`stale`, `contradicted`, `unsupported`, `conflicting`, or `insufficient`.

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

## Gate a belief before you act on it

```ts
import { Kaval } from "@usekaval/kaval";

const kaval = new Kaval({ apiKey: process.env.KAVAL_API_KEY });

const decision = await kaval.verify("Acme's CEO is Jane Doe");
if (!decision.act) {
  // stale / contradicted — re-fetch before relying on it
}
```

`verify()` returns the verdict plus `act` — `true` only when the belief is `current` and confident
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

`audit` · `gateAction` (`gate` alias) · `verify` · `check` · `extractAndCheck` · `scanStore` ·
`monitor` · `reportOutcome` · `kaval` · `kavalBatch` · `health`. Billable methods accept a final
`{ idempotencyKey?, signal?, timeoutMs? }` request-options argument (`kavalBatch` includes it alongside
`concurrency`). Construct with `{ apiKey, baseUrl?, fetch?, timeoutMs? }` — `baseUrl` defaults to
`https://api.usekaval.com`. Works in Node 18+, browsers, and edge runtimes (uses the global `fetch`).

**Env vars:** this package does **not** read `KAVAL_BASE_URL` from the environment — pass
`baseUrl` in the constructor (Python SDK and MCP use `KAVAL_BASE_URL`; the marketing-site proxy
uses `KAVAL_API_URL`). See the [clients README](../README.md#api-origin-env-vars).

The Python client mirrors this surface: `pip install kaval`.

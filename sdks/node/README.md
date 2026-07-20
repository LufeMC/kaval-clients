# @usekaval/kaval

Before an AI agent acts, Kaval verifies the facts the action relies on and returns a time-bounded
signed proof your policy can enforce — `ALLOW`, `REVIEW`, or `BLOCK`.

Policy engines decide whether an action is permitted under the rules; Kaval verifies whether the
facts those rules depend on are still true.

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

`audit()` builds the proof — the expensive research path. `gate()` applies it at act time with no
search, parsing, or model call.

```ts
import { Kaval, ProofNotFoundError } from "@usekaval/kaval";

const kaval = new Kaval({ apiKey: process.env.KAVAL_API_KEY });

// 1. Build, sign, and persist a complete action-bound proof packet.
const proof = await kaval.audit({
  text: "Acme is eligible for a $12,000 refund",
  as_of: new Date().toISOString(),
  intended_action: "Issue Acme a $12,000 refund",
  materiality: "critical",
  reversibility: "irreversible",
  false_allow_cost_usd: 12_000,
  record: { system: "billing", table: "refunds", id: "acme-2026" },
});

// 2. At the exact action boundary, apply the durable proof — cheap and research-free.
try {
  const gate = await kaval.gate({
    proof_id: proof.proof_id,
    material_claim_ids: proof.action_decision.material_claim_ids,
    threshold: proof.action_decision.threshold,
    action: proof.research_contract.action,
  });
  if (gate.state !== "current" || gate.decision.decision !== "ALLOW") {
    throw new Error("Kaval did not allow the action"); // fail closed
  }
} catch (error) {
  if (error instanceof ProofNotFoundError) {
    // No durable proof matches this proof_id/proof_key — build one with audit() first.
  }
  throw error;
}
```

`audit()` returns the complete typed `ProofPacket`: atomic claims, policy bindings, immutable source
versions, exact evidence spans, lineage families, claim assessments, calibrated/withheld risk,
provenance, expiry, and an Ed25519 signature (`signature.algorithm: "Ed25519"`, key id like
`proof-ed25519-2026-07`).

`gate()` returns `{ proofId, state, decision, billingClass, proofReused, researchPerformed: false,
latencyMs }`. `state` is one of `current`, `not_yet_valid`, `expired`, `invalidated`,
`dependency_changed`, `integrity_failed`, `policy_mismatch`, or `operational_failure`. A missing
proof is never a 200 state: the server returns HTTP 404 `proof_not_found`, which this client throws
as the typed `ProofNotFoundError` (a `KavalError` subclass with `code: "proof_not_found"`).
`gateAction()` remains as an alias for `gate()`.

## Verify a single conclusion (compatibility surface)

`verify()` checks one load-bearing conclusion against its evidence references and returns
`valid`, `invalidated`, or `could_not_verify` plus a signed proof receipt. Production actions
should build proof with `audit()` and enforce it with `gate()`.

```ts
const { status, receipt } = await kaval.verify({
  conclusion: "The 2024 International Building Code is the current IBC edition.",
  evidence_refs: ["https://codes.iccsafe.org/content/IBC2024V2.0"],
});

status; // "valid" | "invalidated" | "could_not_verify"
receipt.decision; // "ALLOW" | "BLOCK" | "REVIEW"
receipt.reason; // e.g. "All material claims verified against current evidence."
receipt.share_endpoint; // "/v1/proofs/<id>/share"
receipt.packet; // the full signed ProofPacket
receipt.packet.action_decision.expires_at; // expiry lives here, not on the receipt
```

Each item in `evidence_refs` (1–20 entries) is **either** a plain https URL string **or** a strict
`{ url, document_id }` object; `document_id` values must be unique per request. A bare `{ url }`
object without `document_id` is invalid — pass the plain string instead. The client rejects these
wire-invalid shapes locally before spending a request.

## Ed25519 receipts, verifiable offline

Receipts are Ed25519-signed. Anyone can verify one offline with the open verifier
(`@kaval/receipt-verifier` in the main Kaval repo) against the published JWK at
`GET /v1/proof-verification-keys/:kid` — no Kaval account required.

## Honest boundaries

Demo results carry no organizational authority. A production `ALLOW` requires a customer-bound
action policy and applicable empirical calibration; `REVIEW` is never permission.

## Safe retries and idempotency

Every billable call automatically sends a fresh UUID `Idempotency-Key`. If the connection fails
without a trustworthy response, or the API says the operation is still being finalized, the client
retries once with the same key. It does not retry ordinary API errors, rate limits, or terminal 5xx
responses.

Pass your own key when an outer job/retry system needs to keep one logical operation stable:

```ts
const operationId = crypto.randomUUID();
const proof = await kaval.audit(
  { text: "Acme is eligible for a $12,000 refund", as_of: new Date().toISOString() },
  { idempotencyKey: operationId },
);
```

Reuse a key only after an ambiguous/no-response failure. After receiving a terminal response, start
a new key for any new attempt. `reportOutcome()` and `health()` are not billable and do not send this
header. If both bounded attempts remain ambiguous, the thrown `KavalError` or transport error exposes
the generated key as `error.idempotencyKey`; pass it back explicitly after your own delay to resume
the same operation instead of starting and billing a new one.

All billable methods accept `{ idempotencyKey?, signal?, timeoutMs? }`. The constructor defaults to
a 30-second deadline; override per call or set `timeoutMs: null` to disable it. Cancellation and
timeout errors retain `error.idempotencyKey`, because an interrupted billable request can be
ambiguous.

## Legacy held-belief compatibility

The original currentness API remains available under legacy names — the server still accepts a
belief-freshness body on the same `/v1/verify` route:

```ts
const decision = await kaval.verifyBelief("Acme's CEO is Jane Doe");
if (!decision.act) {
  // stale / contradicted — re-fetch before relying on it
}
```

`verifyBelief()` returns the verdict plus `act` — `true` only when the belief is `current` and
confident (≥ 0.7 by default; override with `minConfidence`). `mode` selects a speed/depth tier
(`instant` | `fast` | `auto` | `deep`); the deep tier adds a cited `explanation`. The related legacy
surfaces also still work: `check`, `extractAndCheck`, `scanStore`, `monitor`, `kaval`, `kavalBatch`,
and `reportOutcome`.

```ts
const report = await kaval.scanStore({
  beliefs: ["Acme is on the Enterprise plan", "Jane Doe is VP Eng at Acme"],
});
report.riskiest.forEach((r) => console.log(r.belief, "→", r.status));

// …or get pushed the newly-stale ones:
await kaval.monitor({ beliefs, webhook: "https://your-app.com/hooks/stale" });
```

## API

`audit` · `gate` (`gateAction` alias) · `verify` · `verifyBelief` · `check` · `extractAndCheck` ·
`scanStore` · `monitor` · `reportOutcome` · `kaval` · `kavalBatch` · `health`. Billable methods
accept a final `{ idempotencyKey?, signal?, timeoutMs? }` request-options argument (`kavalBatch`
includes it alongside `concurrency`). Construct with `{ apiKey, baseUrl?, fetch?, timeoutMs? }` —
`baseUrl` defaults to `https://api.usekaval.com`. Works in Node 18+, browsers, and edge runtimes
(uses the global `fetch`).

**Env vars:** this package does **not** read `KAVAL_BASE_URL` from the environment — pass
`baseUrl` in the constructor (Python SDK and MCP use `KAVAL_BASE_URL`; the marketing-site proxy
uses `KAVAL_API_URL`). See the [clients README](../README.md#api-origin-env-vars).

The Python client mirrors this surface: `pip install kaval`.

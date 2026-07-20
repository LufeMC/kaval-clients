# Kaval clients

Open-source client libraries for [Kaval](https://usekaval.com). Before an AI agent acts, Kaval
verifies the facts the action relies on and returns a time-bounded signed proof your policy can
enforce — `ALLOW`, `REVIEW`, or `BLOCK`.

**Policy engines decide whether an action is permitted under the rules; Kaval verifies whether the
facts those rules depend on are still true.**

These are **thin HTTP clients** for the hosted Kaval API (`https://api.usekaval.com`). Create an API
key at [usekaval.com](https://usekaval.com).

The Node, Python, and MCP surfaces automatically attach a unique idempotency key to billable
operations and reuse it for one bounded retry only when the transport outcome is ambiguous or the
API is still finalizing that operation.

| Package                         | Language          | Install                 | Source                       |
| ------------------------------- | ----------------- | ----------------------- | ---------------------------- |
| [`@usekaval/kaval`](sdks/node)  | Node / TypeScript | `npm i @usekaval/kaval` | [sdks/node](sdks/node)       |
| [`kaval`](sdks/python)          | Python            | `pip install kaval`     | [sdks/python](sdks/python)   |
| [`@usekaval/mcp`](packages/mcp) | MCP server        | `npx -y @usekaval/mcp`  | [packages/mcp](packages/mcp) |

## One verification surface

- **`audit()`** builds the proof — the expensive path. It re-derives the facts behind an intended
  action and returns a full signed proof packet with a typed action decision and expiry.
- **`gate()`** applies that proof at act time — no search, no parsing, no model call. It answers
  "is this proof still valid for this action, right now?" with a typed state and decision.
- **`verify()`** is the compatibility surface for single conclusions: one assertable proposition
  plus the evidence it rests on, in; a bounded status plus a signed receipt, out.

## Verify a conclusion (Node)

```ts
import { Kaval } from "@usekaval/kaval";

const kaval = new Kaval({ apiKey: process.env.KAVAL_API_KEY });

const result = await kaval.verify({
  conclusion:
    "The 2024 International Building Code is the current IBC edition.",
  evidence_refs: [
    "https://codes.iccsafe.org/content/IBC2024V2.0",
    {
      url: "https://www.iccsafe.org/products-and-services/",
      document_id: "icc-catalog-2026",
    },
  ],
  as_of: new Date().toISOString(),
  materiality: "high",
});

// result.status: "valid" | "invalidated" | "could_not_verify"
if (result.status !== "valid") holdWorkflow(result);

// result.receipt: { proof_id, decision: "ALLOW" | "BLOCK" | "REVIEW", reason,
//                   share_endpoint: "/v1/proofs/<id>/share", packet: <full signed ProofPacket> }
// Expiry lives on the signed packet: result.receipt.packet.action_decision.expires_at
await saveReceipt(result.receipt);
```

`evidence_refs` takes 1–20 entries; each is either a plain `https` URL string or a strict
`{ url, document_id }` object (an object without `document_id` is invalid — use the plain string
form instead), and `document_id` values must be unique. Optional fields: `as_of` (RFC 3339 with
offset), `materiality` (`low | medium | high | critical`), `intended_action`, `reversibility`
(`reversible | partially_reversible | irreversible | unknown`), `jurisdiction`, `context`. Unknown
fields are rejected.

## Verify a conclusion (Python)

```python
from kaval import KavalClient

kaval = KavalClient(api_key=os.environ["KAVAL_API_KEY"])

result = kaval.verify({
    "conclusion": "The 2024 International Building Code is the current IBC edition.",
    "evidence_refs": ["https://codes.iccsafe.org/content/IBC2024V2.0"],
})
if result["status"] != "valid":
    hold_workflow(result)
save_receipt(result["receipt"])  # receipt["decision"] is "ALLOW" | "BLOCK" | "REVIEW"
```

## MCP

```bash
KAVAL_API_KEY=kv_live_… npx -y @usekaval/mcp
```

Exposes the verification surface (`verify`, `proof_audit`, `proof_gate`) plus the legacy
compatibility tools (`currentness_check`, `currentness_extract_and_check`, `currentness_scan_store`,
`currentness_monitor`, the legacy-named belief verify, and `report_outcome`) over stdio. See
[packages/mcp](packages/mcp).

## Build a proof, then gate the action (Node)

```ts
const proof = await kaval.audit({
  text: "Acme Corp's vendor security attestation is active and unexpired",
  as_of: new Date().toISOString(),
  intended_action: "Grant Acme's integration production data access",
  materiality: "critical",
  reversibility: "irreversible",
});
// proof is the full signed ProofPacket: proof_id, research_contract, claim_dag,
// source_versions, evidence_spans, claim_assessments, action_decision, expiry, signature.

const gate = await kaval.gate({
  proof_id: proof.proof_id,
  material_claim_ids: proof.action_decision.material_claim_ids,
  threshold: proof.action_decision.threshold,
  action: proof.research_contract.action,
});
// gate.state: "current" | "not_yet_valid" | "expired" | "invalidated" | "dependency_changed"
//           | "integrity_failed" | "policy_mismatch" | "operational_failure"
// (an unknown proof surfaces as a typed proof_not_found error, not a state)
if (gate.state === "current" && gate.decision.decision === "ALLOW") {
  await performAction();
} else {
  holdAction(gate); // REVIEW is never permission
}
```

A changed, expired, or invalidated dependency prevents an old permission from silently remaining
valid — the gate returns a typed non-`current` state instead of reusing the proof.

## Signed receipts, verifiable offline

Every proof packet carries a signature — `{ "algorithm": "Ed25519", "key_id":
"proof-ed25519-2026-07", "signature": "…" }`. Anyone can verify a receipt offline with the open
verifier (`@kaval/receipt-verifier` in the main repo) against the public JWK served at
`GET /v1/proof-verification-keys/:kid` — no Kaval account required.

**Honest boundaries:** demo results carry no organizational authority; a production `ALLOW`
requires a customer-bound action policy and applicable empirical calibration; `REVIEW` is never
permission.

## Legacy surfaces

The pre-proof belief-freshness surfaces still work and stay supported: `check`,
`extract-and-check`, `scan-store`, `monitor`, the structured `kaval` / `kaval-batch` endpoints,
`report-outcome`, and `health`. The legacy belief-freshness verify remains available under a
clearly-legacy name (see each package's README) — `verify` itself is the conclusion-verification
surface above.

## API origin env vars

Two names exist on purpose — they are **not** interchangeable:

| Consumer                          | Variable         | Reads env?                    |
| --------------------------------- | ---------------- | ----------------------------- |
| Python SDK / MCP                  | `KAVAL_BASE_URL` | yes                           |
| Node `@usekaval/kaval`            | —                | pass `baseUrl` in constructor |
| Marketing site proxy (`apps/web`) | `KAVAL_API_URL`  | yes (server only)             |

Use the same origin value in both vars when self-hosting (e.g. `http://localhost:8787`). See
[`SELFHOST.md`](https://github.com/LufeMC/kaval/blob/main/SELFHOST.md) in the core repo.

## Development

```bash
pnpm install
pnpm check        # build + lint + typecheck + test (the JS packages)

# Python SDK
cd sdks/python && pip install -e ".[dev]" && pytest
```

## License

[Apache-2.0](LICENSE).

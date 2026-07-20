# @usekaval/mcp

Before an AI agent acts, [Kaval](https://usekaval.com) verifies the facts the action relies on and
returns a time-bounded signed proof your policy can enforce — **ALLOW**, **REVIEW**, or **BLOCK**.
This package exposes that verification surface as an MCP server.

Policy engines decide whether an action is permitted under the rules; Kaval verifies whether the
facts those rules depend on are still true.

This package is a **thin client** over the hosted Kaval API. All classification, grounding, and
retrieval run server-side, so you bring just a Kaval API key — no model or search keys, no local
engine.

Billable tool calls automatically carry a unique operation key. The underlying client reuses it for
one bounded retry only when the transport outcome is ambiguous or the API is still finalizing the
same operation, preventing duplicate billing without retrying terminal errors.

If both attempts remain ambiguous, the tool error includes `idempotency_key`. Retry later by passing
that exact value back as the optional `idempotency_key` argument on the same billable tool. Omit it
for a genuinely new operation.

## Run it

```bash
npx -y @usekaval/mcp
```

It speaks MCP over stdio. Point any MCP client at it.

### Client config

```jsonc
{
  "mcpServers": {
    "kaval": {
      "command": "npx",
      "args": ["-y", "@usekaval/mcp"],
      "env": {
        "KAVAL_API_KEY": "kv_live_…",
      },
    },
  },
}
```

## Tools

| Tool                            | What it does                                                                                              |
| ------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `verify`                        | Verify one load-bearing conclusion against its evidence references → `valid` / `invalidated` / `could_not_verify` + a signed proof receipt. |
| `proof_audit`                   | Build the complete action-bound ProofPacket: claims, evidence, lineage, decision, expiry, Ed25519 signature. |
| `proof_gate`                    | Apply an existing durable proof to the exact action at act time — no search, parsing, or model call.      |
| `currentness_verify`            | Legacy held-belief compatibility: `act` (boolean) + a typed verdict + proof.                              |
| `currentness_check`             | The raw freshness verdict without the act/don't-act decision.                                             |
| `currentness_extract_and_check` | Pull the checkable beliefs out of a paragraph and re-ground each.                                         |
| `currentness_scan_store`        | Sweep a batch of beliefs for drift (summary + the riskiest).                                              |
| `currentness_monitor`           | Sweep + POST the newly-risky beliefs to a webhook (run on a schedule).                                    |
| `report_outcome`                | Report what actually happened for a prior check so the service can calibrate.                             |

## The proof lifecycle

`proof_audit` builds the proof (the expensive path); `proof_gate` applies it at act time with no
search, parsing, or model call; `verify` is the compatibility surface for single conclusions.

`verify` takes the exact `conclusion` the workflow intends to rely on plus 1–20 `evidence_refs` —
each either a plain `https` URL string or a strict `{ url, document_id }` object with unique
`document_id` values (a bare object without `document_id` is invalid; use the plain string form).
It returns `status: valid | invalidated | could_not_verify` and a signed `receipt` with `proof_id`,
`decision` (`ALLOW`, `REVIEW`, or `BLOCK`), `reason`, a `share_endpoint`, and the full signed
`packet`. There is no receipt-level `expires_at` — expiry lives at
`receipt.packet.action_decision.expires_at`.

`proof_audit` returns the raw ProofPacket: `research_contract`, `claim_dag`, `source_versions`,
`evidence_spans`, `claim_assessments`, `action_decision` (with `expires_at`), `expiry` (with
`recheck_at` and `invalidation_triggers`), and an Ed25519 `signature` (key ids like
`proof-ed25519-2026-07`).

`proof_gate` returns the proof `state` (`current`, `not_yet_valid`, `expired`, `invalidated`,
`dependency_changed`, `integrity_failed`, `policy_mismatch`, or `operational_failure`), the full
`decision`, `billingClass`, and reuse flags. A missing proof surfaces as a typed `proof_not_found`
error, not a 200 state. Only when `enforcement.controlApplied` is `true` may Kaval control the
action; then honor `enforcement.executionAllowed` exactly. `controlApplied: false` is shadow
telemetry — the customer's existing action path remains authoritative. If `enforcement` is absent,
fail closed unless the proof state is `current` and the decision is `ALLOW`.

Receipts are Ed25519-signed; anyone can verify one offline with the open verifier
(`@kaval/receipt-verifier` in the main repo) against `GET /v1/proof-verification-keys/:kid`.

**Honest boundaries:** demo results carry no organizational authority; a production `ALLOW`
requires a customer-bound action policy and applicable empirical calibration; `REVIEW` is never
permission to act.

## Legacy currentness tools

A verdict status is one of: `current`, `stale`, `contradicted`, `unsupported`, `conflicting`,
`insufficient`. Treat anything other than `current` (or `act === false`) as "re-research before
relying on it". These `currentness_*` tools preserve the original held-belief API for
compatibility; prefer `verify` for single conclusions and `proof_audit` + `proof_gate` for
consequential actions.

## Environment

| Var              | Required | Purpose                                                                                   |
| ---------------- | -------- | ----------------------------------------------------------------------------------------- |
| `KAVAL_API_KEY`  | yes      | Bearer key for the hosted Kaval API (create one at https://usekaval.com)                  |
| `KAVAL_BASE_URL` | no       | Override the API base URL (self-hosted / staging). Defaults to `https://api.usekaval.com` |

The marketing site uses **`KAVAL_API_URL`** for its `/api/verify` proxy — not `KAVAL_BASE_URL`.

## Programmatic use

This package is primarily a CLI (`kaval-mcp`). It also exports the server factory for embedding:

```ts
import { createMcpServer, createClientFromEnv } from "@usekaval/mcp";

const server = createMcpServer(createClientFromEnv());
// connect `server` to your own MCP transport
```

Or pass your own configured client:

```ts
import { createMcpServer } from "@usekaval/mcp";
import { Kaval } from "@usekaval/kaval";

const server = createMcpServer(
  new Kaval({ apiKey: process.env.KAVAL_API_KEY }),
);
```

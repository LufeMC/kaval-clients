# @usekaval/mcp

Before an AI agent acts, [Kaval](https://usekaval.com) verifies the facts that action depends on and
answers **ALLOW**, **REVIEW**, or **BLOCK** with a signed receipt. This package exposes that as an
MCP server.

Policy engines decide whether an action is permitted under the rules; Kaval verifies whether the
facts those rules depend on are still true.

This package is a **thin client** over the hosted Kaval API. All compilation, grounding, and
retrieval run server-side, so you bring just a Kaval API key — no model or search keys, no local
engine.

> **0.6 is a breaking release.** Nine tools became seven, and everything removed folded into `check`; the
> API answers `410 tool_retired` for the old routes and this server translates that into an error
> that tells the agent to call `check`. See [Migrating from 0.5](#migrating-from-05).

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

| Tool             | What it does                                                                                                          |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `check`          | **The one that does the work.** Send the action you are about to take (or the claims it rests on) → `ALLOW` / `REVIEW` / `BLOCK`, per-fact status, and a signed receipt. |
| `get_receipt`    | The full signed document behind a check's `receipt.id` — per-fact evidence basis, decision-rule version, signing key. What an agent attaches when it blocks. |
| `add_source`     | Tell Kaval what to watch — a URL, a named authority to resolve, or a document you will push in.                        |
| `list_sources`   | What Kaval currently watches for this workspace, including sources it auto-registered after a check cited them.        |
| `remove_source`  | Stop watching a source and forget it. The only thing that frees registry capacity, which auto-registered sources also consume. |
| `report_outcome` | Report what actually happened after a prior check (by `receipt.id`), so Kaval can calibrate.                           |
| `verify`         | **Deprecated** pilot alias: one conclusion + explicit `evidence_refs` → a signed ProofPacket receipt. Use `check`.     |

## `check`

```jsonc
// arguments
{
  "action": "Approve this prior-authorization request at the in-network rate",
  "context": "payer: Aetna; CPT 12345; plan HMO",
  "materiality": "critical"
}
```

Or skip extraction entirely by naming the facts:

```jsonc
{
  "claims": [
    { "subject": "Aetna", "predicate": "requires_prior_auth_for", "object": "CPT 12345",
      "scope": { "plan": "HMO", "state": "CA" } },
    "The 2024 IBC is the current edition"
  ],
  "mode": "fast"
}
```

The response:

| field          | meaning                                                                                             |
| -------------- | ---------------------------------------------------------------------------------------------------- |
| `decision`     | `ALLOW` — every material fact still holds on fresh evidence, proceed.<br>`REVIEW` — something is unknown, mid-re-evaluation, or changed at low/medium materiality. **REVIEW is never permission to act.**<br>`BLOCK` — a high/critical fact changed, or a critical fact is unknown. |
| `reason_codes` | one or more of `ALL_FACTS_HOLD`, `FACT_CHANGED`, `FACT_EXPIRED`, `FACT_UNKNOWN`, `SOURCE_UPDATED_PENDING_REVIEW`, `SOURCE_UNREACHABLE`, `NEW_FACT_UNVERIFIED`, `COMPILATION_UNCERTAIN` |
| `facts[]`      | `{ fingerprint, text, status: holds \| changed \| unknown, materiality, served_from_state, last_verified_at, sources[] }` — this is how you see *which* belief moved |
| `receipt`      | `{ id, signature, signed_at }`. Pass `receipt.id` to `report_outcome`, or to `get_receipt` for the full signed document |
| `latency_ms`   | `{ compile, lookup, live, total }`                                                                    |

`mode: "fast"` answers only from stored state and reports anything unknown as `unknown`;
`"standard"` (default) may research a stale or novel fact within `max_wait_ms`. A fact that misses
the budget comes back `unknown` — it does **not** warm the next check, because that check recompiles
the action and asks about different fact fingerprints.

**The budget.** The API's own default is `100000` ms, because a cold action check with several novel
premises routinely needs 50–100s of live research. MCP cannot spend that: an MCP client cancels a
tool call after 60s. So this server sends `max_wait_ms: 45000` explicitly and caps the argument
there, and gives its HTTP client a 55s deadline so the timeout fires here — as
`{"error":"timeout"}` with a recovery move — rather than as a cancelled request. Pass a smaller
`max_wait_ms` when a bounded `REVIEW` beats waiting; `0` disables research entirely, which is what
`mode: "fast"` does. Direct HTTP and SDK callers are not bound by any of this and get the full
`100000`.

A fact already backed by a watched source is answered from stored state in ~50ms with zero model
calls and zero fetches, so calling `check` on every consequential action is cheap. A fact Kaval has
never seen has to be researched first, and that takes seconds.

## Keeping checks warm

`add_source` is what makes a check a database read instead of a research run. Registering the *name*
of an authority is usually enough:

```jsonc
{ "kind": "entity", "name": "Aetna", "intent": "payer policy bulletins" }
```

Kaval resolves that to the pages that publish it and watches them adaptively. `kind: "url"` watches
one page; `kind: "push"` is a document your own system sends to `POST /v1/events`. Registering is
optional — a source a check cites is auto-watched — but registering first is what makes the *first*
check on a fact fast.

That auto-watching is why `remove_source` exists. A workspace watches a bounded number of *active*
sources (200), auto-registered sources count against the same bound, and only deletion frees it —
pausing does not. An agent that registers per task and never removes will eventually fill the
registry, after which new citations are dropped silently and checks that used to be warm go back to
researching. Remove what a task registered when the task is done.

## Delta webhooks are not an agent tool

Watched sources are only half the mechanism: when a source changes, Kaval re-evaluates the dependent
facts and pushes a `fact_state.delta` webhook naming what flipped. **That subscription is
deliberately not exposed as an MCP tool.** It is one-time deployment configuration — it mints a
standing outbound callback bound to an https endpoint and a signing secret that must be stored, which
is a deploy-time decision for a human or a service, not an in-loop choice for an agent that owns
neither the endpoint nor the secret.

Configure it once from the SDK (`kaval.subscribeFactStateDeltas({ callback_url })` in Node,
`kaval.subscribe_fact_state_deltas(callback_url=…)` in Python), from `POST /v1/webhooks` with
`subscription_kind: "fact_state"`, or from the dashboard. The agent then just calls `check`, and it
is already fast and already current.

## Migrating from 0.5

| 0.5 tool                        | 0.6                                                                                    |
| ------------------------------- | --------------------------------------------------------------------------------------- |
| `currentness_check`             | `check` — `{ action }` or `{ claims: ["…"] }`                                            |
| `currentness_verify`            | `check` — branch on `decision === "ALLOW"` instead of `act === true`                      |
| `currentness_extract_and_check` | `check` — pass the paragraph as `action`/`context`; Kaval compiles the facts itself       |
| `currentness_scan_store`        | `check` — `{ claims: [...] }`, up to 20 per call                                         |
| `currentness_monitor`           | `add_source` + a `fact_state` webhook subscription (see above) — deltas are pushed to you |
| `proof_audit`                   | `check` — the receipt **is** the proof; `get_receipt` returns the signed document         |
| `proof_gate`                    | `check` — the warm path re-checks in ~50ms, so there is nothing to re-apply separately   |
| `report_outcome`                | `report_outcome` (unchanged; pass `receipt.id`)                                          |
| `verify`                        | `verify`, now deprecated → move to `check`                                               |

Status mapping: `current` + `act: true` → `decision: "ALLOW"` with every fact `holds`;
`stale`/`contradicted` → a fact `changed` (`REVIEW` or `BLOCK` by materiality);
`unsupported`/`insufficient`/`conflicting` → a fact `unknown` (`REVIEW`, or `BLOCK` if critical).

A 0.5 client calling a removed route gets `410 {"error":"tool_retired","replacement":"/v1/check"}`,
which this server surfaces as `{"error":"tool_retired","message":"this capability was folded into
the check tool …","status":410}`.

## Idempotency

`verify` is the only billable tool that carries an operation key: it attaches a unique
`idempotency_key` automatically and reuses it for one bounded retry when the transport outcome is
ambiguous or the API is still finalizing that operation. If both attempts stay ambiguous the tool
error includes `idempotency_key` — pass that exact value back on a later retry.

`check` deliberately carries none: it is a read of current state, so a retry recomputes rather than
replays and cannot double-bill.

## Tool errors

A failed tool call returns `isError: true` and a JSON body naming what happened, so an agent can
branch on it rather than parse prose.

| `error`                | what to do                                                              |
| ---------------------- | ------------------------------------------------------------------------ |
| any API code (`unauthorized`, `insufficient_balance`, `bad_request`, …) | returned verbatim with `status` and the API's `message` |
| `tool_retired`         | 410 — the message names the route that replaced the one you called       |
| `timeout`              | retry with `mode: "fast"` or a smaller `max_wait_ms`                     |
| `network_unreachable`  | the API was never reached — check `KAVAL_BASE_URL` and network access    |
| `request_ambiguous`    | a billable call whose outcome is unknown; retry with the returned `idempotency_key` |

## Signed receipts

Check receipts are Ed25519-signed and self-derivable: because the decision table is published, the
receipt's own fact list re-derives the verdict offline, byte for byte, with no server. Verify one
with `@usekaval/kaval/verify` — a dependency-free subpath of the Node SDK this package already
depends on, plus the `kaval-receipt-verify` CLI that SDK ships. It answers cryptographic validity,
key trust, and freshness separately, needs no Kaval account and no API key, and reads the public
keys from the unauthenticated `GET /v1/proof-verification-keys/:kid` — or from a keyset you archived
beside the receipt, which is the fully offline path.

```bash
npx -p @usekaval/kaval kaval-receipt-verify verify receipt.json \
  --key-url https://api.usekaval.com/v1/proof-verification-keys
```

`check` returns only `{ id, signature, signed_at }`. Call `get_receipt` with that `id` for the
document that was actually signed — every fact with its state, the evidence basis under it (source
locator, content digest and what the digest covers, fetch and publication time), the decision-rule
version, and the signing key id. That is the artifact to attach to a `BLOCK` you escalate.

**Honest boundaries:** demo results carry no organizational authority; a production `ALLOW` requires
a customer-bound action policy and applicable empirical calibration; `REVIEW` is never permission to
act.

## Environment

| Var              | Required | Purpose                                                                                   |
| ---------------- | -------- | ----------------------------------------------------------------------------------------- |
| `KAVAL_API_KEY`  | yes      | Bearer key for the hosted Kaval API (create one at https://usekaval.com)                  |
| `KAVAL_BASE_URL` | no       | Override the API base URL (self-hosted / staging). Defaults to `https://api.usekaval.com` |

Both are declared in `server.json` and `smithery.yaml`, so a registry install can point at a
self-hosted deployment rather than only at the hosted API.

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

# @usekaval/mcp

The [Kaval](https://usekaval.com) **evidence gate for AI agents** as an MCP server. Before an agent
acts, Kaval checks that the current evidence still supports that exact action. It can find current
offer evidence or react when evidence behind an existing conclusion changes.

**Search retrieves evidence. Kaval decides whether that evidence is sufficient for the action.**

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

| Tool                            | What it does                                                                                             |
| ------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `product_research`              | Research ordinary product text with canonical groups, prices, and bounded coverage. Review-only.         |
| `offer_search`                  | Find exact/possible offer evidence. Review-only: never `ALLOW` or `SAFE_TO_QUOTE`.                       |
| `offer_search_gate`             | Final-fence one persisted offer generation. Always `REVIEW` with permission withheld.                    |
| `currentness_verify`            | Pre-action gate: returns `act` (boolean) + a typed verdict + proof. Call before acting on a held belief. |
| `currentness_check`             | The raw freshness verdict without the act/don't-act decision.                                            |
| `currentness_extract_and_check` | Pull the checkable beliefs out of a paragraph and re-ground each.                                        |
| `currentness_scan_store`        | Sweep a batch of beliefs for drift (summary + the riskiest).                                             |
| `currentness_monitor`           | Sweep + POST the newly-risky beliefs to a webhook (run on a schedule).                                   |
| `proof_audit`                   | Build a complete action-bound ProofPacket with exact evidence, policy, lineage, risk, and expiry.        |
| `proof_gate`                    | Apply a durable proof to the exact action and return staged enforcement without repeating research.      |
| `report_outcome`                | Report what actually happened for a prior check so the service can calibrate.                            |

`product_research` is Kaval's primary product-only workflow. It needs only a product query; market,
destination, and filters are optional, while execution budgets remain server-owned. It returns the
same canonical review-only result as REST, Node, and Python. When the MCP caller requests progress,
the tool consumes ordered Product Research SSE and forwards accepted, interpreted, source,
candidate, group, failed, cancelled, and replay events as `notifications/progress`, including the
full canonical event under `usekaval.com/product-research-progress`. Every completed, failed, or
cancelled terminal carries its exact canonical result; the tool returns that result directly without
a follow-up JSON request. Transport errors remain errors, and cancellation propagates to the active
operation. Authority remains `{ mode: "review_only", action_authorized: false, permission:
"withheld" }`. The underlying client rejects verified offers and candidate progress whose material
fields are not bound to the same tier, origin URL, observation, and exact evidence receipt.

`offer_search` resolves the requested product across permitted, accessible configured catalogs,
feeds, retailer/search workers, origin pages, browser-rendered DOM, and checkout resolvers. It
returns `NEEDS_REVIEW` or `NO_RELIABLE_OFFER` with candidates and evidence. The source ledger
reports gaps rather than claiming exhaustive coverage of the entire internet. Current output is
shadow-grade: every candidate must go to human review, and the tool does not authorize a quote or
purchase.

When an MCP client requests progress for the tool call, Kaval consumes the hosted Offer Search SSE
stream and forwards its monotonic `accepted`, acquisition, verification, coverage,
`candidate_provisional`, candidate, and warning events as `notifications/progress`. The provisional
event arrives before completion;
its MCP message explicitly states `durable=false`, `actionable=false`, and
`permission=withheld`, while final inclusion and lifecycle persistence are still pending. Its
structured progress metadata preserves candidate ID, merchant, price, URL, verification, and action
fields for clients that need more than the display message. The tool response remains the one
canonical final result. Progress is explicitly `research_only` / `REVIEW`; a same-key durable replay
is labeled as replayed work, carries the final request binding, and never fabricates acquisition.
Clients that do not request progress use the ordinary JSON call.

New runtime results can include destination-aware `candidate.checkout` evidence: price components,
landed-total validation, stock, seller authorization, observation expiry, resolver version, and
operational gaps. `result.acquisition.source_ledger` records every bounded source as succeeded,
failed, cancelled, prohibited, deferred, or unsearched. This makes coverage limits inspectable; it
does not make the shadow result safe to quote.

When `offer_search` returns `lifecycle.persistence: "persisted"`, pass its dependency, generation,
digest, and action binding to `offer_search_gate` immediately before the action boundary. The gate
re-reads that exact generation and the latest stream head. It always returns `REVIEW` with
`permission: "withheld"`; any non-current state requires refresh or human review, and even
`current_review_only` is not permission to quote or purchase.

For consequential actions, call `proof_audit`, then `proof_gate` immediately before execution. Only
when `enforcement.controlApplied` is `true` may Kaval control the action; then honor
`enforcement.executionAllowed` exactly. In shadow mode `controlApplied` is `false`,
`executionAllowed` is `null`, and `wouldAllow` is counterfactual telemetry—the customer's existing
action path remains authoritative. If `enforcement` is absent, a direct integration should fail
closed unless the proof state is `current` and the decision is `ALLOW`.

A verdict status is one of: `current`, `stale`, `contradicted`, `unsupported`, `conflicting`,
`insufficient`. Treat anything other than `current` (or `act === false`) as "re-research before
relying on it". These `currentness_*` tools preserve the original held-belief API for compatibility;
the product category is the broader evidence gate.

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

# @usekaval/mcp

The [Kaval](https://usekaval.com) freshness gate as an **MCP server**. It gives your agent a
pre-action currentness check: hand it a belief the agent already holds — a cached fact, a stored
field, a retrieved RAG chunk, a prior answer — and it independently re-derives the truth and returns
whether it's still safe to act on.

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
| `currentness_verify`            | Pre-action gate: returns `act` (boolean) + a typed verdict + proof. Call before acting on a held belief. |
| `currentness_check`             | The raw freshness verdict without the act/don't-act decision.                                            |
| `currentness_extract_and_check` | Pull the checkable beliefs out of a paragraph and re-ground each.                                        |
| `currentness_scan_store`        | Sweep a batch of beliefs for drift (summary + the riskiest).                                             |
| `currentness_monitor`           | Sweep + POST the newly-risky beliefs to a webhook (run on a schedule).                                   |
| `report_outcome`                | Report what actually happened for a prior check so the service can calibrate.                            |

A verdict status is one of: `current`, `stale`, `contradicted`, `unsupported`, `conflicting`,
`insufficient`. Treat anything other than `current` (or `act === false`) as "re-research before
relying on it".

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

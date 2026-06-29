# Kaval clients

Open-source client libraries for [Kaval](https://usekaval.com) — the freshness gate for AI agents.
Before your agent acts on a belief it already holds (a cached fact, a stored field, a retrieved RAG
chunk, a prior answer), Kaval independently re-derives the truth from the live world and returns a
typed, abstaining verdict your agent can branch on.

These are **thin HTTP clients** for the hosted Kaval API (`https://api.usekaval.com`). Create an API
key at [usekaval.com](https://usekaval.com).

| Package                          | Language          | Install              | Source                       |
| -------------------------------- | ----------------- | -------------------- | ---------------------------- |
| [`@usekaval/kaval`](sdks/node)   | Node / TypeScript | `npm i @usekaval/kaval` | [sdks/node](sdks/node)       |
| [`kaval`](sdks/python)           | Python            | `pip install kaval`  | [sdks/python](sdks/python)   |
| [`@usekaval/mcp`](packages/mcp)     | MCP server        | `npx -y @usekaval/mcp`  | [packages/mcp](packages/mcp) |

## Node

```ts
import { Kaval } from "@usekaval/kaval";

const kaval = new Kaval({ apiKey: process.env.KAVAL_API_KEY });

const { act, status, reason } = await kaval.verify({
  belief: "Acme is on our Enterprise plan",
  url: "https://billing.acme.com/account",
  held_at: "2026-03-01T00:00:00Z",
});
if (!act) {
  // status ∈ stale | contradicted | unsupported | insufficient — re-research before acting.
}
```

## Python

```python
from kaval import KavalClient

kaval = KavalClient(api_key=os.environ["KAVAL_API_KEY"])
decision = kaval.verify(belief="Acme is on our Enterprise plan")
if not decision["act"]:
    ...  # re-research before acting
```

## MCP

```bash
KAVAL_API_KEY=kv_live_… npx -y @usekaval/mcp
```

Exposes `currentness_verify` (the pre-action gate) plus `currentness_check`, `…_extract_and_check`,
`…_scan_store`, `…_monitor`, and `report_outcome` over stdio. See [packages/mcp](packages/mcp).

## API origin env vars

Two names exist on purpose — they are **not** interchangeable:

| Consumer | Variable | Reads env? |
| -------- | -------- | ---------- |
| Python SDK / MCP | `KAVAL_BASE_URL` | yes |
| Node `@usekaval/kaval` | — | pass `baseUrl` in constructor |
| Marketing site proxy (`apps/web`) | `KAVAL_API_URL` | yes (server only) |

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

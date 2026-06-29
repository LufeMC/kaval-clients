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

## Pick a speed/depth tier

```ts
const decision = await kaval.verify({ belief: "Acme's CEO is Jane Doe", mode: "deep" });

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

`verify` · `check` · `extractAndCheck` · `scanStore` · `monitor` · `reportOutcome` · `kaval` ·
`kavalBatch` · `health`. Construct with `{ apiKey, baseUrl?, fetch? }` — `baseUrl` defaults to
`https://api.usekaval.com`. Works in Node 18+, browsers, and edge runtimes (uses the global `fetch`).

**Env vars:** this package does **not** read `KAVAL_BASE_URL` from the environment — pass
`baseUrl` in the constructor (Python SDK and MCP use `KAVAL_BASE_URL`; the marketing-site proxy
uses `KAVAL_API_URL`). See the [clients README](../README.md#api-origin-env-vars).

The Python client mirrors this surface: `pip install kaval`.

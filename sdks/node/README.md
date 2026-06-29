# kaval

The freshness gate for AI. Give kaval a belief your system already holds — a cached fact, a CRM
field, an agent memory — and it checks the live world and returns a typed verdict: `current`,
`stale`, `contradicted`, `unsupported`, `conflicting`, or `insufficient`.

```bash
npm install kaval
```

## Gate a belief before you act on it

```ts
import { Kaval } from "kaval";

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
The Python client mirrors this surface: `pip install kaval`.

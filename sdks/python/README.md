# kaval (Python SDK)

The freshness gate for AI. Give [kaval](https://github.com/LufeMC/kaval-clients) a belief your system
already holds — a cached fact, a CRM field, an agent memory — and it checks the live world and
returns a typed freshness gap: `current` / `stale` / `contradicted` / `unsupported` / `conflicting`
/ `insufficient`.

## Install

```bash
pip install kaval
```

## Gate a belief before you act on it

```python
from kaval import KavalClient

# base_url defaults to the hosted cloud (https://api.usekaval.com).
with KavalClient(api_key="kv_live_...") as client:
    decision = client.verify("Acme's CEO is Jane Doe")
    if not decision["act"]:
        ...  # stale / contradicted — re-fetch before relying on it
```

`verify()` returns the verdict plus `act` — `True` only when the belief is `current` and confident
(≥ 0.7 by default; override with `min_confidence`).

### Pick a speed/depth tier

`verify(belief, mode=...)` selects a tier (default `auto`): `instant` (cache / graph-prior only, no
fetch or LLM), `fast` (cheap model, origin-only), `auto` (balanced), or `deep` (strongest model + a
cited explanation). The returned dict echoes `tier`, and on the `deep` tier adds `explanation`:

```python
gap = client.verify("Acme's CEO is Jane Doe", mode="deep")
gap["tier"]                       # "deep"
gap["explanation"]["content"]     # markdown rationale with [n] citations (deep only)
gap["explanation"]["citations"]   # [{"url": ..., "title"?: ...}] — only from gathered evidence
gap["explanation"]["confidence"]  # "high" | "medium" | "low"
```

### Sweep a store for drift

```python
report = client.scan_store(["Acme is on the Enterprise plan", "Jane Doe is VP Eng at Acme"])
for r in report["riskiest"]:
    print(r["belief"], "→", r["status"])

# …or get pushed the newly-stale ones (carry `state` across runs so a still-stale belief
# isn't re-delivered every sweep):
client.monitor(beliefs, webhook="https://your-app.com/hooks/stale")
```

## Custom base URL

Override the API base URL (e.g. a staging environment or a local proxy):

```python
client = KavalClient(base_url="https://staging.api.usekaval.com", api_key="...")
```

## API

`verify` · `check` · `extract_and_check` · `scan_store` · `monitor` · `report_outcome` ·
`kaval` · `kaval_batch` · `health`. Construct with `KavalClient(base_url=?, api_key=?)` —
`base_url` defaults to `https://api.usekaval.com`. The Node/TypeScript client mirrors this surface:
`npm install kaval`.

## Test

```bash
pip install -e ".[dev]"            # from sdks/python (development)
pytest                             # hermetic contract tests (httpx MockTransport)
KAVAL_BASE_URL=https://api.usekaval.com KAVAL_API_KEY=kv_live_... pytest   # also runs the live test
```

# Kaval verification benchmark — how we measure "is it right?"

Kaval is a **pre-action gate**: you hand it a belief, it re-derives the truth from the live world and
returns a typed verdict — `current`, `stale`, `contradicted`, `unsupported`, `conflicting`, or
`insufficient` — plus a confidence, a reason, and the evidence it fetched. A gate has to be **right when
it says stop** and **honest when it can't be sure**, so we grade it against real, web-verified beliefs
rather than a relevance score.

## Headline numbers

- **158 / 159 (99.4%)** on the graded eval set — a curated, web-verified suite spanning execs, entities,
  documents, values/versions, URLs, certifications, pricing, funding, source-less corroboration, and
  natural-language classification.
- **Regression-gated in CI at zero API spend.** Every LLM/HTTP/search response is recorded once, then the
  real engine **replays them deterministically offline** — so any change that worsens a verdict fails CI
  without spending a cent. Live verdicts can drift run-to-run; the committed replay is exact.
- **The one miss is documented, not hidden:** a near-empty `"???"` / whitespace adversarial input grounded
  to an unrelated page and returned a confident verdict instead of `insufficient` — a degenerate-input edge
  on the source-less path.

## Head-to-head vs. "just use an LLM + web search"

Same graded cases, same verdict taxonomy, same scoring — Kaval vs. a naive `OpenAI web_search` + prompt
loop (the 140 verdict-graded cases):

| | Accuracy | Confidently wrong | Cost / check | Latency |
| --- | --- | --- | --- | --- |
| **Kaval `verify()`** (live, auto tier) | **139/140 (99.3%)** | **1** | **$0.0099** | **3.3 s** |
| OpenAI `web_search` + prompt (naive loop) | 135/140 (96.4%) | 5 | $0.0462 | 18.7 s |

More accurate, **5× fewer confidently-wrong answers**, ~4.7× cheaper, ~5.7× faster. Two of the naive
loop's five errors were adversarial injection cases it was talked into — where the gate holds the line.

## Reproduce it

- **Fastest:** type any claim into the live demo at **[usekaval.com](https://usekaval.com)** — that is the
  same engine returning a live verdict on a belief of your choosing.
- **See what's tested:** [`eval-sample.json`](./eval-sample.json) is a representative subset of the graded
  cases — subject, fact type, and the acceptable verdicts for each. `expected` is a *set* of acceptable
  statuses (a former exec may read `stale`, `contradicted`, or `unsupported` depending on the source); a
  few strict fact types (SOC-2 Type-II, live pricing, funding) are left to manual assessment because they
  demand strong primary proof and often **correctly abstain** rather than over-claim.

The full graded suite and the deterministic replay harness run inside the closed-source engine's CI, so
this repo publishes the **cases and methodology** (what we hold ourselves to), not the engine itself.

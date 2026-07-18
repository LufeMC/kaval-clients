# Kaval clients

Open-source client libraries for [Kaval](https://usekaval.com), the **evidence gate for AI agents**.
Before an AI agent acts, Kaval checks that the current evidence still supports the action. It returns
`ALLOW`, `REVIEW`, or `BLOCK` with supporting evidence; when that evidence changes or expires, the
permission does too.

**Search retrieves evidence. Kaval decides whether that evidence is sufficient for the action.**

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

## Two workflows, one evidence-gate product

- **Find current offer evidence.** Product Research accepts product text with optional market,
  destination, and filters—no ZIP, manufacturer, model, identifier, or customer-controlled execution
  budget is required. It returns canonical exact/possible/conflicting groups, prices, availability,
  refinements, warnings, and bounded coverage. A sufficiently identified result can enter the
  optional exact-action Offer Search lane, which adds destination and action constraints. Both
  surfaces remain review-only until representative calibration supports a narrower claim: they
  return withheld authority, `NEEDS_REVIEW`, or `NO_RELIABLE_OFFER`, never `ALLOW` or
  `SAFE_TO_QUOTE`.
- **React when evidence changes.** Build an action-bound proof, then gate reuse at the action
  boundary. A changed, expired, or invalidated dependency prevents an old permission from silently
  remaining valid.

Both workflows follow the same lifecycle: evidence → supported conclusion → permission for one
action → expiry or evidence change → review, re-evaluation, or renewed permission.

## Node

```ts
import { Kaval } from "@usekaval/kaval";

const kaval = new Kaval({ apiKey: process.env.KAVAL_API_KEY });

const research = await kaval.researchProducts({
  query: "cordless framing nailer",
  market: { country_code: "US", preferred_currency: "USD" },
});
for await (const event of kaval.streamProductResearch({
  query: "cordless framing nailer",
})) {
  if (event.type === "group_updated") renderProductGroup(event.group);
  if (event.type === "completed") renderResearch(event.result);
}
// research.authority.permission === "withheld": Product Research never authorizes an action.

const offers = await kaval.searchOffers(offerRequest);
if (offers.action.state === "NEEDS_REVIEW") {
  await queueForHumanReview(offers.candidates);
}
// Never quote or purchase from current Offer Search output without review.

if (offers.lifecycle?.persistence === "persisted") {
  const finalFence = await kaval.gateOfferSearch({
    dependency_id: offers.lifecycle.dependency_id,
    generation_id: offers.lifecycle.generation_id,
    generation_number: offers.lifecycle.generation_number,
    generation_digest: offers.lifecycle.generation_digest,
    action_binding: offers.lifecycle.action_binding,
  });
  // Every state remains REVIEW-only with permission withheld. Refresh any non-current generation.
  if (finalFence.state !== "current_review_only") await refreshOfferEvidence();
}

// The SSE surface emits research-only progress, or `replay` for an already-completed same-key
// operation, followed by the same canonical final result.
for await (const event of kaval.streamOfferSearch(offerRequest)) {
  if (event.type === "candidate_provisional") {
    // Display-only: not durable, not actionable, permission is withheld, final inclusion is pending.
    renderProvisionalOffer(event.details.candidate);
  } else if (event.type === "final") {
    await queueForHumanReview(event.result.candidates);
  }
}

const proof = await kaval.audit({
  text: "Acme is eligible for a $12,000 refund",
  as_of: new Date().toISOString(),
  intended_action: "Issue the refund",
  materiality: "critical",
  reversibility: "irreversible",
});
const gate = await kaval.gateAction({
  proof_id: proof.proof_id,
  material_claim_ids: proof.action_decision.material_claim_ids,
  threshold: proof.action_decision.threshold,
  action: proof.research_contract.action,
});
if (
  gate.enforcement?.controlApplied === true &&
  gate.enforcement.executionAllowed !== true
) {
  throw new Error("Kaval blocked the action");
}
if (
  gate.enforcement === undefined &&
  (gate.state !== "current" || gate.decision.decision !== "ALLOW")
) {
  throw new Error("Kaval did not allow the action");
}
// controlApplied === false is shadow mode: observe wouldAllow without controlling the action.

// Legacy held-belief compatibility remains available:
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
research = kaval.research_products({
    "query": "cordless framing nailer",
    "market": {"country_code": "US", "preferred_currency": "USD"},
})
# research["authority"]["permission"] == "withheld"

offers = kaval.search_offers(offer_request)
if offers["action"]["state"] == "NEEDS_REVIEW":
    queue_for_human_review(offers["candidates"])

if offers.get("lifecycle", {}).get("persistence") == "persisted":
    lifecycle = offers["lifecycle"]
    final_fence = kaval.gate_offer_search({
        "dependency_id": lifecycle["dependency_id"],
        "generation_id": lifecycle["generation_id"],
        "generation_number": lifecycle["generation_number"],
        "generation_digest": lifecycle["generation_digest"],
        "action_binding": lifecycle["action_binding"],
    })
```

## MCP

```bash
KAVAL_API_KEY=kv_live_… npx -y @usekaval/mcp
```

Exposes primary review-only `product_research` with MCP progress, review-only
`offer_search` + `offer_search_gate`, and `proof_audit` + `proof_gate` for the full evidence-gate protocol,
plus legacy compatibility tools
`currentness_verify`, `currentness_check`, `…_extract_and_check`, `…_scan_store`, `…_monitor`, and
`report_outcome` over stdio. See [packages/mcp](packages/mcp).

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

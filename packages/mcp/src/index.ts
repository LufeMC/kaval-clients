/**
 * @usekaval/mcp — an evidence gate for AI agents. Exposes review-only offer_search plus its
 * action-time offer_search_gate, the action-bound proof_audit / proof_gate lifecycle, legacy currentness compatibility tools, and report_outcome,
 * built on the thin `kaval` HTTP client for the hosted Kaval API.
 * Run the stdio server via the `kaval-mcp` bin (for `mcp add` / `npx @usekaval/mcp`).
 */
export { createMcpServer } from "./server.js";
export { createClientFromEnv } from "./env.js";
export type {
  CommerceLiveSourceAttempt,
  LiveOfferSearchResult,
  ProductResearchExecutionReceipt,
  ProductResearchResult,
} from "@usekaval/kaval";

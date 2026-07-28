/**
 * @usekaval/mcp — the Kaval verification surface for AI agents. Before an agent acts, it sends the
 * proposed action; Kaval identifies the facts that action depends on, checks them against the
 * sources it watches, and answers ALLOW, REVIEW, or BLOCK with a signed receipt.
 *
 * Seven tools: `check` (the one that does the work), `get_receipt` (the signed document behind its
 * verdict), `add_source` / `list_sources` / `remove_source` (what Kaval watches, which is what keeps
 * `check` warm), `report_outcome`, and the deprecated `verify` pilot alias. Built on the thin
 * `kaval` HTTP client for the hosted Kaval API. Run the stdio server via the `kaval-mcp` bin (for
 * `mcp add` / `npx @usekaval/mcp`).
 */
export { createMcpServer } from "./server.js";
export { createClientFromEnv } from "./env.js";

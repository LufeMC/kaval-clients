/**
 * @usekaval/mcp — the Kaval verification surface for AI agents. Before an agent acts, it sends the
 * proposed action; Kaval identifies the facts that action depends on, checks them against the
 * sources it watches, and answers ALLOW, REVIEW, or BLOCK with a signed receipt.
 *
 * Twenty-three tools cover checks, receipts, sources, contracts, bulletins, bulk imports, training
 * review, explicit training consent, outcomes, and the deprecated `verify` pilot alias. The server
 * uses the thin `kaval` HTTP client for the hosted Kaval API. Run the stdio server through the
 * `kaval-mcp` bin.
 */
export { createMcpServer } from "./server.js";
export { createClientFromEnv } from "./env.js";

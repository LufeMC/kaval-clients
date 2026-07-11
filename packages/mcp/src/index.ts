/**
 * @usekaval/mcp — the primary agent-facing surface (plan.md Phase 4). An MCP server exposing
 * currentness_verify / currentness_check / currentness_extract_and_check / currentness_scan_store /
 * currentness_monitor / proof_audit / proof_gate / report_outcome, built on the thin `kaval` HTTP
 * client (the hosted Kaval API).
 * Run the stdio server via the `kaval-mcp` bin (for `mcp add` / `npx @usekaval/mcp`).
 */
export { createMcpServer } from "./server.js";
export { createClientFromEnv } from "./env.js";

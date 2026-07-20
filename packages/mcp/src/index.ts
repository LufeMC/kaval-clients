/**
 * @usekaval/mcp — the Kaval verification surface for AI agents. Before an agent acts, Kaval
 * verifies the facts the action relies on and returns a time-bounded signed proof a policy can
 * enforce — ALLOW, REVIEW, or BLOCK. Exposes the primary `verify` conclusion tool, the
 * `proof_audit` / `proof_gate` lifecycle, legacy currentness compatibility tools, and
 * `report_outcome`, built on the thin `kaval` HTTP client for the hosted Kaval API.
 * Run the stdio server via the `kaval-mcp` bin (for `mcp add` / `npx @usekaval/mcp`).
 */
export { createMcpServer } from "./server.js";
export { createClientFromEnv } from "./env.js";

// Build the agent-facing client from env. MCP is a *thin client* over the hosted Kaval API —
// it carries no engine and no model/search keys; all classification, grounding, and retrieval run
// server-side. The only secret it needs is a Kaval API key for https://api.usekaval.com.
import { Kaval } from "@usekaval/kaval";

/** Thrown when required MCP env (e.g. KAVAL_API_KEY) is missing or invalid. */
export class McpConfigError extends Error {
  override readonly name = "McpConfigError";
}

export function isMcpConfigError(error: unknown): error is McpConfigError {
  return error instanceof McpConfigError;
}

export function createClientFromEnv(
  env: Record<string, string | undefined> = process.env,
): Kaval {
  const apiKey = env.KAVAL_API_KEY;
  if (!apiKey) {
    throw new McpConfigError(
      "KAVAL_API_KEY is required — create a key at https://usekaval.com and set KAVAL_API_KEY.",
    );
  }
  // KAVAL_BASE_URL is optional; the client defaults to https://api.usekaval.com.
  //
  // The transport deadline is MCP's constraint, not the API's. A cold check researches for as long
  // as the server's budget allows (up to 100s), so the client's own 30s default aborted the headline
  // call a third of the way in — but the ceiling here is lower still: `@modelcontextprotocol/sdk`
  // cancels a tool call after DEFAULT_REQUEST_TIMEOUT_MSEC (60s), and a caller-side cancellation
  // reaches the agent as a dead request rather than an error it can act on. 55s is the widest
  // deadline that still fires on OUR side, leaving room for the narrowed research budget in
  // server.ts plus the round-trip around it.
  return new Kaval({
    apiKey,
    baseUrl: env.KAVAL_BASE_URL,
    timeoutMs: 55_000,
  });
}

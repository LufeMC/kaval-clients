// Build the agent-facing client from env. MCP is a *thin client* over the hosted Kaval API —
// it carries no engine and no model/search keys; all classification, grounding, and retrieval run
// server-side. The only secret it needs is a Kaval API key for https://api.usekaval.com.
import { Kaval } from "kaval";

export function createClientFromEnv(
  env: Record<string, string | undefined> = process.env,
): Kaval {
  const apiKey = env.KAVAL_API_KEY;
  if (!apiKey) {
    throw new Error(
      "KAVAL_API_KEY is required — create a key at https://usekaval.com and set KAVAL_API_KEY.",
    );
  }
  // KAVAL_BASE_URL is optional; the client defaults to https://api.usekaval.com.
  return new Kaval({ apiKey, baseUrl: env.KAVAL_BASE_URL });
}

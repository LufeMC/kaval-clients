import { DEFAULT_CHECK_MAX_WAIT_MS, Kaval } from "../dist/index.js";

let idempotencyKey;
const client = new Kaval({
  fetch: async (_url, init) => {
    idempotencyKey = init?.headers?.["idempotency-key"];
    return {
      ok: true,
      status: 200,
      json: async () => ({
        status: "valid",
        receipt: { proof_id: "node18-smoke", decision: "ALLOW" },
      }),
    };
  },
});

// `verify()` is the one method that spends an operation key, so it is the one that exercises the
// Node 18 fallback: that runtime exposes `fetch` globally but not always Web Crypto.
await client.verify({
  conclusion: "Node 18 can generate an operation key.",
  evidence_refs: ["https://example.com/source"],
});

if (
  !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    idempotencyKey ?? "",
  )
) {
  throw new Error(
    `Node 18 generated an invalid idempotency key: ${String(idempotencyKey)}`,
  );
}

// The research-budget constants are VALUE exports, not types — the MCP server imports them to bound
// its own `max_wait_ms`, so a build that erased them would break it and nothing else would notice.
if (DEFAULT_CHECK_MAX_WAIT_MS !== 100_000) {
  throw new Error(
    `DEFAULT_CHECK_MAX_WAIT_MS did not survive the build: ${String(DEFAULT_CHECK_MAX_WAIT_MS)}`,
  );
}

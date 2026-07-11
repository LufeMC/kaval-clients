import { Kaval } from "../dist/index.js";

let idempotencyKey;
const client = new Kaval({
  fetch: async (_url, init) => {
    idempotencyKey = init?.headers?.["idempotency-key"];
    return {
      ok: true,
      status: 200,
      json: async () => ({
        id: "node18-smoke",
        status: "current",
        confidence: 1,
        reason: "runtime smoke",
        checked_at: new Date(0).toISOString(),
        evidence: [],
      }),
    };
  },
});

await client.check("Node 18 can generate an operation key");

if (
  !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    idempotencyKey ?? "",
  )
) {
  throw new Error(
    `Node 18 generated an invalid idempotency key: ${String(idempotencyKey)}`,
  );
}

/** A fake `/v1/*` fetch that always rejects with the given product-API error envelope, so MCP tests can
 *  exercise the out-of-credit (402) / invalid-key (401) paths without the network or the engine. */
export function failingKavalFetch(
  status: number,
  code: string,
  message?: string,
): typeof fetch {
  return async () =>
    new Response(
      JSON.stringify({ error: { code, ...(message ? { message } : {}) } }),
      { status, headers: { "content-type": "application/json" } },
    );
}

/** Canned `/v1/*` responses for MCP conformance without network or the private engine. */
export const fakeKavalFetch: typeof fetch = async (input, init) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  const path = new URL(url).pathname;
  const body = init?.body
    ? (JSON.parse(init.body as string) as Record<string, unknown>)
    : {};

  // MCP inherits the Node HTTP client. Keep the fake hosted contract strict so conformance fails if
  // a billable tool ever stops sending the operation key required by issued-key traffic.
  if (
    path !== "/v1/report-outcome" &&
    !new Headers(init?.headers).get("idempotency-key")
  ) {
    return new Response(
      JSON.stringify({ error: { code: "idempotency_key_required" } }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }

  let data: unknown;
  switch (path) {
    case "/v1/check":
      data = {
        id: "chk_1",
        status: "current",
        confidence: 0.9,
        reason: "team page confirms it",
        checked_at: "2026-06-24T18:04:11.000Z",
        evidence: [],
      };
      break;
    case "/v1/verify": {
      const tier = (body.mode as string) ?? "auto";
      data = {
        id: "vf_1",
        status: "current",
        act: true,
        confidence: 0.9,
        reason: "team page confirms it",
        checked_at: "2026-06-24T18:04:11.000Z",
        evidence: [],
        tier,
        ...(tier === "deep"
          ? {
              explanation: {
                content: "Confirmed by the team page [1].",
                citations: [{ url: "https://acme.com/team" }],
                confidence: "high",
              },
            }
          : {}),
      };
      break;
    }
    case "/v1/extract-and-check":
      data = {
        beliefs: [
          {
            belief: "Jane Doe is at Acme",
            id: "b1",
            status: "current",
            confidence: 0.9,
          },
          {
            belief: "Acme has SOC 2",
            id: "b2",
            status: "current",
            confidence: 0.9,
          },
        ],
      };
      break;
    default:
      return new Response(JSON.stringify({ error: "not found" }), {
        status: 404,
      });
  }
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};

export function parseToolText(res: unknown): {
  status?: string | number;
  id?: string;
  beliefs?: unknown[];
  tier?: string;
  explanation?: { confidence?: string; citations?: { url: string }[] };
  error?: string;
  message?: string;
} {
  const content = (res as { content: Array<{ type: string; text: string }> })
    .content;
  return JSON.parse(content[0]!.text);
}

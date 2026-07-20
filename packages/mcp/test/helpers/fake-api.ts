import { readFileSync } from "node:fs";

/** A fake `/v1/*` fetch that always rejects with the given API error envelope, so MCP tests can
 *  exercise the out-of-credit (402) / invalid-key (401) / proof_not_found (404) paths without the
 *  network or the engine. */
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

const fixture = <T>(name: string): T =>
  JSON.parse(
    readFileSync(
      new URL(`../../../../fixtures/${name}`, import.meta.url),
      "utf8",
    ),
  ) as T;

/** The exact POST /v1/verify PRIMARY response shape (conclusion + evidence_refs in, signed receipt
 *  out). NOTE: there is deliberately no receipt-level expires_at — expiry lives at
 *  receipt.packet.action_decision.expires_at. */
export const fakeVerifyReceipt = fixture<Record<string, any>>(
  "mcp-verify-receipt-v1.json",
);

/** The exact POST /v1/audit response: the raw Ed25519-signed ProofPacket. */
export const fakeAuditProofPacket = fixture<Record<string, any>>(
  "mcp-audit-proof-packet-v1.json",
);

/** The exact POST /v1/gate response for a current, enforceable proof. */
export const fakeGateResult = fixture<Record<string, any>>(
  "mcp-gate-result-v1.json",
);

/** A canonical primary-shape verify request (mixed plain-URL and { url, document_id } refs). */
export const fakeVerifyRequest = {
  conclusion:
    "The 2024 International Building Code is the current IBC edition.",
  evidence_refs: [
    "https://codes.iccsafe.org/content/IBC2024V2.0",
    {
      url: "https://www.iccsafe.org/products-and-services/i-codes/2024-i-codes/",
      document_id: "icc-2024-i-codes",
    },
  ],
  as_of: "2026-07-20T12:00:00.000Z",
  materiality: "high",
  intended_action: "Cite the current IBC edition in a permit filing",
  reversibility: "partially_reversible",
  jurisdiction: "US",
  context: "permit filing pre-check",
};

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
      // The live route serves both shapes: the PRIMARY conclusion + evidence_refs body and the
      // legacy belief-freshness fallback body. Dispatch exactly like the hosted API does.
      if ("conclusion" in body) {
        data = fakeVerifyReceipt;
        break;
      }
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
    case "/v1/scan-store":
      data = {
        total: 2,
        tier: "fast",
        by_status: { current: 1, stale: 1 },
        riskiest: [
          {
            belief: "Acme is on our Enterprise plan",
            status: "stale",
            confidence: 0.55,
          },
        ],
      };
      break;
    case "/v1/monitor":
      data = {
        delivered: 1,
        tier: "fast",
        state: { riskyKeys: ["acme-plan"] },
      };
      break;
    case "/v1/audit":
      data = fakeAuditProofPacket;
      break;
    case "/v1/gate":
      data = fakeGateResult;
      break;
    case "/v1/report-outcome":
      data = { ok: true };
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
  state?: string;
  id?: string;
  act?: boolean;
  proof_id?: string;
  proofId?: string;
  created_at?: string;
  research_contract?: Record<string, unknown>;
  claim_dag?: Record<string, unknown>;
  source_versions?: unknown[];
  evidence_spans?: unknown[];
  claim_assessments?: unknown[];
  action_decision?: {
    decision?: string;
    summary?: string;
    expires_at?: string;
  };
  expiry?: {
    recheck_at?: string;
    expires_at?: string;
    invalidation_triggers?: string[];
  };
  signature?: { algorithm?: string; key_id?: string; signature?: string };
  receipt?: {
    proof_id?: string;
    decision?: string;
    reason?: string;
    share_endpoint?: string;
    expires_at?: string;
    packet?: {
      proof_id?: string;
      action_decision?: { decision?: string; expires_at?: string };
      signature?: { algorithm?: string; key_id?: string };
    };
  };
  decision?: { decision?: string };
  billingClass?: string;
  proofReused?: boolean;
  researchPerformed?: boolean;
  latencyMs?: number;
  enforcement?: { mode?: string; executionAllowed?: boolean | null };
  beliefs?: unknown[];
  total?: number;
  riskiest?: unknown[];
  delivered?: number;
  ok?: boolean;
  tier?: string;
  explanation?: { confidence?: string; citations?: { url: string }[] };
  error?: string;
  message?: string;
  idempotency_key?: string;
} {
  const content = (res as { content: Array<{ type: string; text: string }> })
    .content;
  return JSON.parse(content[0]!.text);
}

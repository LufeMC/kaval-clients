import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Kaval, KavalError, ProofNotFoundError } from "../src/index.js";
import type {
  EvidenceRef,
  ProofGateInput,
  ProofGateResult,
  ProofPacket,
  VerifyRequest,
  VerifyResponse,
} from "../src/index.js";

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`../../../fixtures/${name}`, import.meta.url), "utf8"),
  );
}

const VERIFY_RESPONSE = fixture("node-verify-response.json");
const AUDIT_PROOF_PACKET = fixture("node-audit-proof-packet.json");
const GATE_RESULT = fixture("node-gate-result.json");
const GATE_PROOF_NOT_FOUND = fixture("node-gate-proof-not-found.json");

/** A fetch double: the handler decides status + JSON; we capture what the client sent. */
function mockFetch(
  handler: (
    url: string,
    init?: RequestInit,
  ) => { status?: number; json: unknown },
): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    const { status = 200, json } = handler(url, init);
    return {
      ok: status < 400,
      status,
      json: async () => json,
    } as Response;
  }) as unknown as typeof fetch;
}

const GATE_INPUT: ProofGateInput = {
  proof_id: "proof_01JKAVAL0EXAMPLE00000000AA",
  material_claim_ids: ["claim_ibc_current_edition"],
  threshold: {
    policy_id: "policy_codes_current_edition",
    policy_version: "1.0.0",
    materiality: "high",
    maximum_false_allow_risk: 0.02,
    minimum_evidence_coverage: 0.9,
  },
  action: {
    description: "Cite the current IBC edition in a permit filing",
    materiality: "high",
    reversibility: "partially_reversible",
  },
};

describe("verify()", () => {
  it("posts the conclusion + evidence_refs to /v1/verify and returns the typed receipt", async () => {
    let seen:
      | { url: string; auth?: string; idempotencyKey?: string; body: unknown }
      | undefined;
    const kaval = new Kaval({
      apiKey: "kv_live_abc",
      fetch: mockFetch((url, init) => {
        const headers = init?.headers as Record<string, string>;
        seen = {
          url,
          auth: headers?.["authorization"],
          idempotencyKey: headers?.["idempotency-key"],
          body: JSON.parse(init?.body as string),
        };
        return { json: VERIFY_RESPONSE };
      }),
    });

    const request: VerifyRequest = {
      conclusion:
        "The 2024 International Building Code is the current IBC edition.",
      evidence_refs: [
        "https://codes.iccsafe.org/content/IBC2024V2.0",
        {
          url: "https://codes.iccsafe.org/content/IBC2024V2.0",
          document_id: "ibc-2024-v2",
        },
      ],
      as_of: "2026-07-20T10:59:00.000Z",
      materiality: "high",
      intended_action: "Cite the current IBC edition in a permit filing",
      reversibility: "partially_reversible",
      jurisdiction: "US",
    };
    const response: VerifyResponse = await kaval.verify(request, {
      idempotencyKey: "verify-operation-0001",
    });

    expect(seen?.url).toBe("https://api.usekaval.com/v1/verify");
    expect(seen?.auth).toBe("Bearer kv_live_abc");
    expect(seen?.idempotencyKey).toBe("verify-operation-0001");
    expect(seen?.body).toEqual(request);

    expect(response).toEqual(VERIFY_RESPONSE);
    expect(response.status).toBe("valid");
    expect(response.receipt.proof_id).toBe("proof_01JKAVAL0EXAMPLE00000000AA");
    expect(response.receipt.decision).toBe("ALLOW");
    expect(response.receipt.reason).toBe(
      "All material claims verified against current evidence.",
    );
    expect(response.receipt.share_endpoint).toBe(
      "/v1/proofs/proof_01JKAVAL0EXAMPLE00000000AA/share",
    );
    // No receipt-level expires_at: expiry lives at receipt.packet.action_decision.expires_at.
    expect("expires_at" in response.receipt).toBe(false);
    expect(response.receipt.packet.action_decision.expires_at).toBe(
      "2026-07-27T10:59:45.000Z",
    );
    expect(response.receipt.packet.signature?.algorithm).toBe("Ed25519");
    expect(response.receipt.packet.signature?.key_id).toBe(
      "proof-ed25519-2026-07",
    );
  });

  it("accepts up to 20 plain https URL references", async () => {
    let body: unknown;
    const kaval = new Kaval({
      fetch: mockFetch((_u, init) => {
        body = JSON.parse(init?.body as string);
        return { json: VERIFY_RESPONSE };
      }),
    });
    const evidence_refs = Array.from(
      { length: 20 },
      (_, index) => `https://example.com/source/${index}`,
    );
    await kaval.verify({ conclusion: "x", evidence_refs });
    expect(body).toEqual({ conclusion: "x", evidence_refs });
  });

  it.each([
    {
      name: "an empty evidence_refs array",
      refs: [] as EvidenceRef[],
      message: /between 1 and 20/,
    },
    {
      name: "more than 20 references",
      refs: Array.from(
        { length: 21 },
        (_, index) => `https://example.com/source/${index}`,
      ),
      message: /between 1 and 20/,
    },
    {
      name: "a bare { url } object without document_id",
      refs: [{ url: "https://example.com/source" }] as unknown as EvidenceRef[],
      message: /bare \{ url \} object without document_id is invalid/,
    },
    {
      name: "an object with an empty document_id",
      refs: [
        { url: "https://example.com/source", document_id: "" },
      ] as EvidenceRef[],
      message: /plain https URL string or a \{ url, document_id \} object/,
    },
    {
      name: "duplicate document_id values",
      refs: [
        { url: "https://example.com/a", document_id: "doc-1" },
        { url: "https://example.com/b", document_id: "doc-1" },
      ] as EvidenceRef[],
      message: /document_id values must be unique/,
    },
  ])("rejects $name before any network call", async ({ refs, message }) => {
    let calls = 0;
    const kaval = new Kaval({
      fetch: mockFetch(() => {
        calls += 1;
        return { json: VERIFY_RESPONSE };
      }),
    });
    await expect(
      kaval.verify({ conclusion: "x", evidence_refs: refs }),
    ).rejects.toThrowError(TypeError);
    await expect(
      kaval.verify({ conclusion: "x", evidence_refs: refs }),
    ).rejects.toThrowError(message);
    expect(calls).toBe(0);
  });
});

describe("audit()", () => {
  it("posts the exact request to /v1/audit and returns the raw signed ProofPacket", async () => {
    let seen:
      { url: string; idempotencyKey?: string; body: unknown } | undefined;
    const kaval = new Kaval({
      fetch: mockFetch((url, init) => {
        seen = {
          url,
          idempotencyKey: (init?.headers as Record<string, string>)?.[
            "idempotency-key"
          ],
          body: JSON.parse(init?.body as string),
        };
        return { json: AUDIT_PROOF_PACKET };
      }),
    });

    const packet: ProofPacket = await kaval.audit(
      {
        text: "The 2024 International Building Code is the current IBC edition.",
        as_of: "2026-07-20T10:59:00.000Z",
        intended_action: "Cite the current IBC edition in a permit filing",
        materiality: "high",
        reversibility: "partially_reversible",
        false_allow_cost_usd: 25_000,
        jurisdiction: "US",
        origin_urls: ["https://codes.iccsafe.org/content/IBC2024V2.0"],
      },
      { idempotencyKey: "audit-operation-0001" },
    );

    expect(seen?.url).toBe("https://api.usekaval.com/v1/audit");
    expect(seen?.idempotencyKey).toBe("audit-operation-0001");
    expect(seen?.body).toEqual({
      text: "The 2024 International Building Code is the current IBC edition.",
      as_of: "2026-07-20T10:59:00.000Z",
      intended_action: "Cite the current IBC edition in a permit filing",
      materiality: "high",
      reversibility: "partially_reversible",
      false_allow_cost_usd: 25_000,
      jurisdiction: "US",
      origin_urls: ["https://codes.iccsafe.org/content/IBC2024V2.0"],
    });

    expect(packet).toEqual(AUDIT_PROOF_PACKET);
    expect(packet.proof_id).toBe("proof_01JKAVAL0EXAMPLE00000000AA");
    expect(packet.research_contract.held_belief).toBe(
      "The 2024 International Building Code is the current IBC edition.",
    );
    expect(packet.action_decision.decision).toBe("ALLOW");
    expect(packet.action_decision.summary).toBe(
      "All material claims verified against current evidence.",
    );
    expect(packet.expiry.recheck_at).toBe("2026-07-26T10:59:45.000Z");
    expect(packet.expiry.expires_at).toBe("2026-07-27T10:59:45.000Z");
    expect(packet.signature?.algorithm).toBe("Ed25519");
    expect(packet.signature?.key_id).toBe("proof-ed25519-2026-07");
    expect(
      packet.claim_assessments[0]?.calibration_support.support_fingerprint,
    ).toMatch(/^sha256:/);
  });
});

describe("gate()", () => {
  it("posts one proof locator to /v1/gate and returns the typed gate result", async () => {
    let seen: { url: string; body: unknown } | undefined;
    const kaval = new Kaval({
      fetch: mockFetch((url, init) => {
        seen = { url, body: JSON.parse(init?.body as string) };
        return { json: GATE_RESULT };
      }),
    });

    const result: ProofGateResult = await kaval.gate(GATE_INPUT);

    expect(seen?.url).toBe("https://api.usekaval.com/v1/gate");
    expect(seen?.body).toEqual(GATE_INPUT);
    expect(result).toEqual(GATE_RESULT);
    expect(result.proofId).toBe("proof_01JKAVAL0EXAMPLE00000000AA");
    expect(result.state).toBe("current");
    expect(result.decision.decision).toBe("ALLOW");
    expect(result.billingClass).toBe("action_gate");
    expect(result.proofReused).toBe(true);
    expect(result.researchPerformed).toBe(false);
    expect(result.latencyMs).toBe(6);
  });

  it("surfaces HTTP 404 proof_not_found as a typed ProofNotFoundError", async () => {
    const kaval = new Kaval({
      fetch: mockFetch(() => ({ status: 404, json: GATE_PROOF_NOT_FOUND })),
    });

    const error = await kaval
      .gate(GATE_INPUT, { idempotencyKey: "gate-operation-0001" })
      .catch((value: unknown) => value);

    expect(error).toBeInstanceOf(ProofNotFoundError);
    expect(error).toBeInstanceOf(KavalError);
    expect(error).toMatchObject({
      name: "ProofNotFoundError",
      status: 404,
      code: "proof_not_found",
      payload: GATE_PROOF_NOT_FOUND,
      idempotencyKey: "gate-operation-0001",
    });
  });

  it("keeps a non-proof 404 as a plain KavalError", async () => {
    const kaval = new Kaval({
      fetch: mockFetch(() => ({
        status: 404,
        json: { error: { code: "route_not_found" } },
      })),
    });
    const error = await kaval.gate(GATE_INPUT).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(KavalError);
    expect(error).not.toBeInstanceOf(ProofNotFoundError);
  });

  it("gateAction() alias delegates to gate(), including the typed 404", async () => {
    const kaval = new Kaval({
      fetch: mockFetch(() => ({ status: 404, json: GATE_PROOF_NOT_FOUND })),
    });
    await expect(kaval.gateAction(GATE_INPUT)).rejects.toBeInstanceOf(
      ProofNotFoundError,
    );
  });
});

import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Kaval } from "@usekaval/kaval";
import { describe, expect, it } from "vitest";
import { createMcpServer } from "../src/server.js";
import {
  failingKavalFetch,
  fakeAuditProofPacket,
  fakeGateResult,
  fakeKavalFetch,
  fakeVerifyReceipt,
  fakeVerifyRequest,
  parseToolText,
} from "./helpers/fake-api.js";

/**
 * MCP is a thin client: a request goes MCP tool → `kaval` HTTP client → the hosted `/v1/*` API.
 * We inject a fake `fetch` that returns canned `/v1/*` responses in the EXACT live wire shapes, so
 * this exercises the MCP layer and the tool→client arg threading without touching the network or
 * the (private) engine.
 *
 * For registry-shaped installs (packed tarballs, not workspace symlinks), see published-artifacts.test.ts.
 */
async function connectClient(
  fetchImpl: typeof fetch = fakeKavalFetch,
): Promise<McpClient> {
  const kaval = new Kaval({ apiKey: "kv_live_test", fetch: fetchImpl });
  const server = createMcpServer(kaval);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new McpClient({ name: "conformance-test", version: "0.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return client;
}

/** Capture path + idempotency key + JSON body of the single request a tool call makes. */
function capturingFetch(payload: unknown): {
  fetchImpl: typeof fetch;
  seen: () => {
    path: string;
    key: string | null;
    body: Record<string, unknown>;
  };
} {
  let captured:
    | { path: string; key: string | null; body: Record<string, unknown> }
    | undefined;
  const fetchImpl = (async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    captured = {
      path: new URL(url).pathname,
      key: new Headers(init?.headers).get("idempotency-key"),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return {
    fetchImpl,
    seen: () => {
      if (!captured) throw new Error("the fake API was never called");
      return captured;
    },
  };
}

describe("MCP conformance", () => {
  it("exposes exactly the verification tool surface — no commerce tools", async () => {
    const client = await connectClient();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    // Exact surface snapshot: the primary verify tool first, then the proof lifecycle, then the
    // legacy currentness compatibility tools and outcome reporting.
    expect(names).toEqual([
      "verify",
      "proof_audit",
      "proof_gate",
      "currentness_verify",
      "currentness_check",
      "currentness_extract_and_check",
      "currentness_scan_store",
      "currentness_monitor",
      "report_outcome",
    ]);
    for (const tool of tools) {
      expect(`${tool.name} ${tool.description}`).not.toMatch(
        /offer|product[_ ]research|commerce|quote|purchase|checkout|merchant|seller/i,
      );
    }
  });

  it("verify forwards the primary conclusion body and returns the signed receipt exactly", async () => {
    const { fetchImpl, seen } = capturingFetch(fakeVerifyReceipt);
    const client = await connectClient(fetchImpl);
    const res = await client.callTool({
      name: "verify",
      arguments: {
        ...fakeVerifyRequest,
        idempotency_key: "mcp-verify-operation-0001",
      },
    });
    const out = parseToolText(res);

    expect(seen()).toEqual({
      path: "/v1/verify",
      key: "mcp-verify-operation-0001",
      body: fakeVerifyRequest,
    });
    expect(out).toEqual(fakeVerifyReceipt);
    expect(out.status).toBe("valid");
    expect(out.receipt?.decision).toBe("ALLOW");
    expect(out.receipt?.share_endpoint).toBe(
      `/v1/proofs/${out.receipt?.proof_id}/share`,
    );
    // Expiry deliberately lives at receipt.packet.action_decision.expires_at, never on the receipt.
    expect(out.receipt?.expires_at).toBeUndefined();
    expect(out.receipt?.packet?.action_decision?.expires_at).toBe(
      "2026-07-21T12:00:01.000Z",
    );
    expect(out.receipt?.packet?.signature?.algorithm).toBe("Ed25519");
    expect(out.receipt?.packet?.signature?.key_id).toBe(
      "proof-ed25519-2026-07",
    );
  });

  it.each([
    {
      name: "an empty evidence_refs array",
      arguments: { ...fakeVerifyRequest, evidence_refs: [] },
    },
    {
      name: "more than 20 evidence_refs",
      arguments: {
        ...fakeVerifyRequest,
        evidence_refs: Array.from(
          { length: 21 },
          (_, i) => `https://example.com/evidence/${i}`,
        ),
      },
    },
    {
      name: "a bare object without document_id",
      arguments: {
        ...fakeVerifyRequest,
        evidence_refs: [{ url: "https://example.com/evidence" }],
      },
    },
    {
      name: "duplicate document_id values",
      arguments: {
        ...fakeVerifyRequest,
        evidence_refs: [
          { url: "https://example.com/a", document_id: "doc-1" },
          { url: "https://example.com/b", document_id: "doc-1" },
        ],
      },
    },
    {
      name: "a credential-bearing evidence URL",
      arguments: {
        ...fakeVerifyRequest,
        evidence_refs: ["https://user:secret@example.com/evidence"],
      },
    },
    {
      name: "a non-URL evidence string",
      arguments: {
        ...fakeVerifyRequest,
        evidence_refs: ["the team page says so"],
      },
    },
    {
      name: "a missing conclusion",
      arguments: { evidence_refs: fakeVerifyRequest.evidence_refs },
    },
  ])(
    "verify rejects $name before network access",
    async ({ arguments: arguments_ }) => {
      let calls = 0;
      const client = await connectClient((async () => {
        calls += 1;
        throw new Error("the API must not be called for invalid tool input");
      }) as typeof fetch);
      const res = await client.callTool({
        name: "verify",
        arguments: arguments_,
      });

      expect((res as { isError?: boolean }).isError).toBe(true);
      expect(calls).toBe(0);
    },
  );

  it("currentness_verify still reaches /v1/verify with the legacy belief body", async () => {
    const client = await connectClient();
    const res = await client.callTool({
      name: "currentness_verify",
      arguments: { belief: "Jane Doe is VP Engineering at Acme", mode: "deep" },
    });
    const out = parseToolText(res);
    expect(out.tier).toBe("deep"); // mode survived the MCP schema → client → /v1/verify body
    expect(out.explanation?.confidence).toBe("high"); // deep-only cited synthesis surfaced
    expect(out.explanation?.citations?.[0]?.url).toBe("https://acme.com/team");
  });

  it("an agent calls currentness_check and branches on status (the demo)", async () => {
    const client = await connectClient();
    const res = await client.callTool({
      name: "currentness_check",
      arguments: {
        belief: "Jane Doe is VP Engineering at Acme",
        context: "about to use in a cold email",
        freshness_sla: "14d",
      },
    });
    const gap = parseToolText(res);
    expect([
      "current",
      "stale",
      "contradicted",
      "unsupported",
      "conflicting",
      "insufficient",
    ]).toContain(gap.status);
    expect(gap.id).toBeDefined();
    // The DoD self-gating branch:
    const safeToUse = gap.status === "current";
    expect(typeof safeToUse).toBe("boolean");
  });

  it("extract_and_check finds the checkable beliefs in a paragraph", async () => {
    const client = await connectClient();
    const res = await client.callTool({
      name: "currentness_extract_and_check",
      arguments: { text: "Jane Doe is VP Eng at Acme. Acme has SOC 2." },
    });
    const out = parseToolText(res);
    expect(out.beliefs).toHaveLength(2);
  });

  it("currentness_scan_store round-trips the sweep summary", async () => {
    const client = await connectClient();
    const res = await client.callTool({
      name: "currentness_scan_store",
      arguments: {
        beliefs: [
          "Jane Doe is VP Engineering at Acme",
          "Acme is on our Enterprise plan",
        ],
        mode: "fast",
      },
    });
    const out = parseToolText(res);
    expect(out.total).toBe(2);
    expect(out.tier).toBe("fast");
    expect(Array.isArray(out.riskiest)).toBe(true);
  });

  it("currentness_monitor round-trips delivery and carry-forward state", async () => {
    const client = await connectClient();
    const res = await client.callTool({
      name: "currentness_monitor",
      arguments: {
        beliefs: ["Acme is on our Enterprise plan"],
        mode: "fast",
        webhook: "https://example.com/hooks/stale",
        state: { riskyKeys: [] },
      },
    });
    const out = parseToolText(res);
    expect(out.delivered).toBe(1);
    expect(
      (out as { state?: { riskyKeys?: string[] } }).state?.riskyKeys,
    ).toEqual(["acme-plan"]);
  });

  it("report_outcome round-trips without requiring an idempotency key", async () => {
    const client = await connectClient();
    const res = await client.callTool({
      name: "report_outcome",
      arguments: { id: "vf_1", kind: "relied_and_correct", note: "worked" },
    });
    expect((res as { isError?: boolean }).isError).not.toBe(true);
    expect(parseToolText(res).ok).toBe(true);
  });

  it("proof_audit passes the raw Ed25519-signed ProofPacket through exactly", async () => {
    const { fetchImpl, seen } = capturingFetch(fakeAuditProofPacket);
    const client = await connectClient(fetchImpl);
    const arguments_ = {
      text: "Acme is eligible for a refund",
      as_of: "2026-07-10T20:00:00Z",
      intended_action: "Issue the refund",
      materiality: "critical",
      reversibility: "irreversible",
      false_allow_cost_usd: 12_000,
      record: { system: "billing", table: "refunds", id: "acme" },
    };
    const res = await client.callTool({
      name: "proof_audit",
      arguments: { ...arguments_, idempotency_key: "mcp-audit-operation-0001" },
    });
    const out = parseToolText(res);

    expect(seen()).toEqual({
      path: "/v1/audit",
      key: "mcp-audit-operation-0001",
      body: arguments_,
    });
    expect(out).toEqual(fakeAuditProofPacket);
    expect(out.action_decision?.decision).toBe("REVIEW");
    expect(out.action_decision?.expires_at).toBeDefined();
    expect(out.expiry?.recheck_at).toBeDefined();
    expect(out.signature?.algorithm).toBe("Ed25519");
    expect(out.signature?.key_id).toBe("proof-ed25519-2026-07");
  });

  it("proof_audit rejects credential-bearing origin URLs before network access", async () => {
    const client = await connectClient(() => {
      throw new Error("the API must not be called for an invalid tool input");
    });
    const res = await client.callTool({
      name: "proof_audit",
      arguments: {
        text: "Acme is eligible for a refund",
        as_of: "2026-07-10T20:00:00Z",
        origin_urls: ["https://user:secret@example.com/refund"],
      },
    });
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(
      (res as { content: Array<{ text: string }> }).content[0]?.text,
    ).toContain("must be an http(s) URL");
  });

  it("propagates MCP cancellation into proof_audit's HTTP request", async () => {
    let calls = 0;
    let markStarted!: () => void;
    let markAborted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const aborted = new Promise<void>((resolve) => {
      markAborted = resolve;
    });
    const cancellableFetch = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      calls += 1;
      markStarted();
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        const onAbort = () => {
          markAborted();
          reject(signal?.reason ?? new Error("cancelled"));
        };
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort, { once: true });
      });
    }) as typeof fetch;
    const client = await connectClient(cancellableFetch);
    const controller = new AbortController();
    const pending = client.callTool(
      {
        name: "proof_audit",
        arguments: {
          text: "Acme is eligible for a refund",
          as_of: "2026-07-10T20:00:00Z",
        },
      },
      undefined,
      { signal: controller.signal },
    );

    await started;
    controller.abort(new Error("caller cancelled"));
    await aborted;
    await pending.catch(() => undefined);
    expect(calls).toBe(1);
  });

  it("proof_gate applies a current proof and passes the decision through exactly", async () => {
    const { fetchImpl, seen } = capturingFetch(fakeGateResult);
    const client = await connectClient(fetchImpl);
    const arguments_ = {
      proof_id: "proof_01JMCPAUDIT0000000000001",
      material_claim_ids: [
        "claim:sha256:3333333333333333333333333333333333333333333333333333333333333333",
      ],
      threshold: {
        policy_id: "pricing-current",
        policy_version: "1.0.0",
        materiality: "low",
        maximum_false_allow_risk: 0.01,
        minimum_evidence_coverage: 0.95,
      },
      action: {
        description: "Display the current value",
        materiality: "low",
        reversibility: "reversible",
      },
    };
    const res = await client.callTool({
      name: "proof_gate",
      arguments: arguments_,
    });
    const out = parseToolText(res);

    expect(seen().path).toBe("/v1/gate");
    expect(seen().body).toEqual(arguments_);
    expect(out).toEqual(fakeGateResult);
    expect(out.state).toBe("current");
    expect(out.decision?.decision).toBe("ALLOW");
    expect(out.billingClass).toBe("action_gate");
    expect(out.proofReused).toBe(true);
    expect(out.researchPerformed).toBe(false);
    expect(typeof out.latencyMs).toBe("number");
    expect(out.enforcement).toMatchObject({
      mode: "bounded",
      executionAllowed: true,
    });
  });

  it("proof_gate rejects missing or ambiguous proof locators", async () => {
    const client = await connectClient();
    const common = {
      material_claim_ids: ["claim_1"],
      threshold: {
        policy_id: "policy_1",
        policy_version: "1",
        materiality: "low",
        maximum_false_allow_risk: 0.01,
        minimum_evidence_coverage: 0.9,
      },
      action: {
        description: "Display it",
        materiality: "low",
        reversibility: "reversible",
      },
    };
    for (const arguments_ of [
      common,
      { ...common, proof_id: "proof_1", proof_key: "proof-key:1" },
    ]) {
      const res = await client.callTool({
        name: "proof_gate",
        arguments: arguments_,
      });
      expect((res as { isError?: boolean }).isError).toBe(true);
      expect(parseToolText(res)).toMatchObject({ error: "bad_request" });
    }
  });

  it("proof_gate surfaces a missing proof as a typed proof_not_found error, not a 200 state", async () => {
    const client = await connectClient(
      failingKavalFetch(
        404,
        "proof_not_found",
        "no durable proof matches that locator",
      ),
    );
    const res = await client.callTool({
      name: "proof_gate",
      arguments: {
        proof_id: "proof_missing",
        material_claim_ids: ["claim_1"],
        threshold: {
          policy_id: "policy_1",
          policy_version: "1",
          materiality: "low",
          maximum_false_allow_risk: 0.01,
          minimum_evidence_coverage: 0.9,
        },
        action: {
          description: "Display it",
          materiality: "low",
          reversibility: "reversible",
        },
      },
    });
    expect((res as { isError?: boolean }).isError).toBe(true);
    const out = parseToolText(res);
    expect(out.error).toBe("proof_not_found");
    expect(out.status).toBe(404);
  });

  it("surfaces a zero-balance (402) as a clear out-of-credit error, not 'internal error'", async () => {
    const client = await connectClient(
      failingKavalFetch(
        402,
        "insufficient_balance",
        "out of credit — top up to continue",
      ),
    );
    const res = await client.callTool({
      name: "verify",
      arguments: {
        conclusion: fakeVerifyRequest.conclusion,
        evidence_refs: ["https://codes.iccsafe.org/content/IBC2024V2.0"],
      },
    });
    expect((res as { isError?: boolean }).isError).toBe(true);
    const out = parseToolText(res);
    expect(out.error).toBe("insufficient_balance");
    expect(out.message).toContain("out of credit");
    expect(out.status).toBe(402);
    expect(out.idempotency_key).toBeUndefined();
  });

  it("surfaces a bogus key (401) as a clear invalid-key error, not 'internal error'", async () => {
    const client = await connectClient(
      failingKavalFetch(401, "unauthorized", "invalid API key"),
    );
    const res = await client.callTool({
      name: "currentness_check",
      arguments: { belief: "Jane Doe is VP Engineering at Acme" },
    });
    expect((res as { isError?: boolean }).isError).toBe(true);
    const out = parseToolText(res);
    expect(out.error).toBe("unauthorized");
    expect(out.message).toContain("invalid");
    expect(out.status).toBe(401);
    expect(out.idempotency_key).toBeUndefined();
  });

  it("reuses and returns an MCP recovery key when event persistence is still pending", async () => {
    const seenKeys: string[] = [];
    const pendingFetch = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      seenKeys.push(
        new Headers(init?.headers).get("idempotency-key") ?? "missing",
      );
      return new Response(
        JSON.stringify({
          error: {
            code: "event_persistence_pending",
            message: "verification event is still being persisted",
          },
        }),
        {
          status: 503,
          headers: { "content-type": "application/json" },
        },
      );
    }) as typeof fetch;
    const client = await connectClient(pendingFetch);
    const operationKey = "mcp-logical-operation-0001";

    const res = await client.callTool({
      name: "currentness_check",
      arguments: {
        belief: "Jane Doe is VP Engineering at Acme",
        idempotency_key: operationKey,
      },
    });

    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(parseToolText(res)).toMatchObject({
      error: "event_persistence_pending",
      status: 503,
      idempotency_key: operationKey,
    });
    expect(seenKeys).toEqual([operationKey, operationKey]);
  });

  it("returns the generated recovery key after a terminal transport ambiguity", async () => {
    const transportFailure = (async () => {
      throw new TypeError("connection reset after request write");
    }) as typeof fetch;
    const client = await connectClient(transportFailure);

    const res = await client.callTool({
      name: "verify",
      arguments: {
        conclusion: fakeVerifyRequest.conclusion,
        evidence_refs: ["https://codes.iccsafe.org/content/IBC2024V2.0"],
      },
    });

    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(parseToolText(res)).toMatchObject({
      error: "request_ambiguous",
      idempotency_key: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
  });
});

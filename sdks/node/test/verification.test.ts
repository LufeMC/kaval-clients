import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Kaval } from "../src/index.js";
import type {
  EvidenceRef,
  VerifyRequest,
  VerifyResponse,
} from "../src/index.js";

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`../../../fixtures/${name}`, import.meta.url), "utf8"),
  );
}

const VERIFY_RESPONSE = fixture("node-verify-response.json");

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

/**
 * `verify()` is the deprecated pilot alias kept while the conclusion+evidence_refs integrations
 * migrate to `check()`. Its wire contract must not drift while it is still in the field.
 */
describe("verify() — deprecated pilot alias", () => {
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
    expect(response.receipt.share_endpoint).toBe(
      "/v1/proofs/proof_01JKAVAL0EXAMPLE00000000AA/share",
    );
    // No receipt-level expires_at: expiry lives at receipt.packet.action_decision.expires_at.
    expect("expires_at" in response.receipt).toBe(false);
    expect(response.receipt.packet.action_decision.expires_at).toBe(
      "2026-07-27T10:59:45.000Z",
    );
    expect(response.receipt.packet.signature?.algorithm).toBe("Ed25519");
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

  it("retries one transport-ambiguous failure with the same generated key", async () => {
    const keys: string[] = [];
    let calls = 0;
    const fetchImpl = (async (
      _url: string | URL | Request,
      init?: RequestInit,
    ) => {
      keys.push((init?.headers as Record<string, string>)["idempotency-key"]!);
      calls += 1;
      if (calls === 1)
        throw new TypeError("connection reset after request write");
      return new Response(JSON.stringify(VERIFY_RESPONSE), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    await expect(
      new Kaval({ fetch: fetchImpl }).verify({
        conclusion: "x",
        evidence_refs: ["https://example.com/source"],
      }),
    ).resolves.toMatchObject({ status: "valid" });
    expect(calls).toBe(2);
    expect(keys[1]).toBe(keys[0]);
  });

  it.each([
    "idempotency_in_progress",
    "idempotency_resolution_pending",
    "event_persistence_pending",
  ])("retries %s once with the same caller key", async (code) => {
    const keys: string[] = [];
    let calls = 0;
    const fetchImpl = (async (
      _url: string | URL | Request,
      init?: RequestInit,
    ) => {
      keys.push((init?.headers as Record<string, string>)["idempotency-key"]!);
      calls += 1;
      return new Response(
        JSON.stringify(calls === 1 ? { error: { code } } : VERIFY_RESPONSE),
        {
          status:
            calls === 1
              ? code === "idempotency_in_progress"
                ? 409
                : 503
              : 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as typeof fetch;

    const out = await new Kaval({ fetch: fetchImpl }).verify(
      { conclusion: "x", evidence_refs: ["https://example.com/source"] },
      { idempotencyKey: "caller-operation-0001" },
    );
    expect(out.status).toBe("valid");
    expect(calls).toBe(2);
    expect(keys).toEqual(["caller-operation-0001", "caller-operation-0001"]);
  });

  it("bounds ambiguous retries at two attempts and exposes the recovery key", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(
        JSON.stringify({ error: { code: "idempotency_in_progress" } }),
        { status: 409, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    await expect(
      new Kaval({ fetch: fetchImpl }).verify({
        conclusion: "x",
        evidence_refs: ["https://example.com/source"],
      }),
    ).rejects.toMatchObject({
      status: 409,
      idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(calls).toBe(2);
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

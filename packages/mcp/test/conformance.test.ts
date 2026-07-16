import { readFileSync } from "node:fs";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Kaval } from "@usekaval/kaval";
import { describe, expect, it } from "vitest";
import { createMcpServer } from "../src/server.js";
import {
  failingKavalFetch,
  fakeKavalFetch,
  fakeOfferSearchGateRequest,
  fakeOfferSearchGateResult,
  fakeOfferSearchRequest,
  fakeOfferSearchResult,
  parseToolText,
} from "./helpers/fake-api.js";

const REPRESENTATIVE_WIRE_RESULT = JSON.parse(
  readFileSync(
    new URL("../../../fixtures/offer-search-result-v2.json", import.meta.url),
    "utf8",
  ),
) as Record<string, unknown>;

/**
 * MCP is a thin client now: a request goes MCP tool → `kaval` HTTP client → the hosted `/v1/*` API.
 * We inject a fake `fetch` that returns canned `/v1/*` responses, so this exercises the MCP layer
 * and the tool→client arg threading without touching the network or the (private) engine.
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

describe("MCP conformance", () => {
  it("discovers the two evidence-gate workflows and legacy compatibility tools", async () => {
    const client = await connectClient();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "offer_search",
        "offer_search_gate",
        "currentness_verify",
        "currentness_check",
        "currentness_extract_and_check",
        "currentness_scan_store",
        "currentness_monitor",
        "proof_audit",
        "proof_gate",
        "report_outcome",
      ]),
    );
    expect(names[0]).toBe("offer_search");
  });

  it("offer_search preserves the hosted review-only result and caller operation key", async () => {
    let seen:
      | { path: string; key: string | null; body: Record<string, unknown> }
      | undefined;
    const fetchImpl = (async (input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      seen = {
        path: new URL(url).pathname,
        key: new Headers(init?.headers).get("idempotency-key"),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      };
      return new Response(JSON.stringify(fakeOfferSearchResult), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const client = await connectClient(fetchImpl);
    const res = await client.callTool({
      name: "offer_search",
      arguments: {
        ...fakeOfferSearchRequest,
        idempotency_key: "mcp-offer-search-operation-0001",
      },
    });
    const out = parseToolText(res);

    expect(seen).toEqual({
      path: "/v1/search-offers",
      key: "mcp-offer-search-operation-0001",
      body: fakeOfferSearchRequest,
    });
    expect(out.action?.state).toBe("NEEDS_REVIEW");
    expect(out.candidates?.[0]?.checkout).toMatchObject({
      status: "verified",
      observation: {
        destination_eligibility: "eligible",
        declared_landed_total: { amount_minor: 20_566, currency: "USD" },
      },
      action: { state: "REVIEW", action_authorized: false },
    });
    expect(out.acquisition).toMatchObject({
      coverage_claim: "bounded_not_comprehensive",
      source_ledger: [
        {
          source_id: "catalog-primary",
          family: "catalog",
          disposition: "succeeded",
        },
        {
          source_id: "open-web-tail",
          family: "open_web",
          disposition: "unsearched",
        },
      ],
    });
    expect(JSON.stringify(out)).not.toMatch(/ALLOW|SAFE_TO_QUOTE/);
  });

  it("offer_search forwards review-only SSE events as MCP progress and preserves the final result", async () => {
    const accepted = {
      type: "accepted",
      sequence: 0,
      at: "2026-07-15T00:00:00.000Z",
      request_id: fakeOfferSearchRequest.request_id,
      message: "Offer Search was admitted; every result remains review-only.",
      authority: "research_only",
      action_state: "REVIEW",
      details: { newly_admitted: true },
    };
    const acquisition = {
      type: "acquisition",
      sequence: 1,
      at: "2026-07-15T00:00:00.010Z",
      request_id: fakeOfferSearchRequest.request_id,
      message: "Evidence acquisition started.",
      authority: "research_only",
      action_state: "REVIEW",
      details: { status: "started" },
    };
    const provisional = {
      type: "candidate_provisional",
      sequence: 2,
      at: "2026-07-15T00:00:00.020Z",
      request_id: fakeOfferSearchRequest.request_id,
      message:
        "An origin-verified research candidate is available provisionally; final publication is pending.",
      authority: "research_only",
      action_state: "REVIEW",
      details: {
        request_digest: fakeOfferSearchResult.request_digest,
        origin_sequence: 4,
        publication_state: "provisional",
        durable: false,
        actionable: false,
        permission: "withheld",
        final_inclusion: "not_yet_determined",
        candidate: fakeOfferSearchResult.candidates[0],
      },
    };
    const streamBody = [
      `event: accepted\nid: 0\ndata: ${JSON.stringify(accepted)}\n\n`,
      `event: acquisition\nid: 1\ndata: ${JSON.stringify(acquisition)}\n\n`,
      `event: candidate_provisional\nid: 2\ndata: ${JSON.stringify(provisional)}\n\n`,
      `event: final\nid: 3\ndata: ${JSON.stringify(fakeOfferSearchResult)}\n\n`,
    ].join("");
    let seen:
      { path: string; accept: string | null; key: string | null } | undefined;
    const fetchImpl = (async (input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      seen = {
        path: new URL(url).pathname,
        accept: new Headers(init?.headers).get("accept"),
        key: new Headers(init?.headers).get("idempotency-key"),
      };
      return new Response(streamBody, {
        status: 200,
        headers: { "content-type": "text/event-stream; charset=utf-8" },
      });
    }) as typeof fetch;
    const client = await connectClient(fetchImpl);
    const progress: Array<{
      progress: number;
      total?: number;
      message?: string;
      _meta?: Record<string, unknown>;
    }> = [];
    const res = await client.callTool(
      {
        name: "offer_search",
        arguments: {
          ...fakeOfferSearchRequest,
          idempotency_key: "mcp-offer-stream-operation-0001",
        },
      },
      undefined,
      {
        onprogress: (update) => progress.push(update),
      },
    );
    const out = parseToolText(res);

    expect(seen).toEqual({
      path: "/v1/search-offers",
      accept: "text/event-stream",
      key: "mcp-offer-stream-operation-0001",
    });
    expect(progress).toEqual([
      {
        progress: 0,
        message:
          "accepted: Offer Search was admitted; every result remains review-only.",
      },
      {
        progress: 1,
        message: "acquisition: Evidence acquisition started.",
      },
      {
        progress: 2,
        message:
          "candidate_provisional: origin-verified research candidate; final publication pending; durable=false; actionable=false; permission=withheld",
        _meta: {
          "usekaval.com/offer-search-progress": {
            schema_revision: 1,
            type: "candidate_provisional",
            request_id: fakeOfferSearchRequest.request_id,
            request_digest: fakeOfferSearchResult.request_digest,
            candidate: {
              candidate_id: fakeOfferSearchResult.candidates[0]!.candidate_id,
              merchant: {
                source_id: fakeOfferSearchResult.candidates[0]!.source_id,
                seller_name:
                  fakeOfferSearchResult.candidates[0]!.origin_offer.seller_name,
              },
              price:
                fakeOfferSearchResult.candidates[0]!.checkout.observation
                  ?.item_price,
              url: fakeOfferSearchResult.candidates[0]!.origin_offer
                .purchase_url,
              verification: {
                identity: fakeOfferSearchResult.candidates[0]!.identity,
                disposition: fakeOfferSearchResult.candidates[0]!.disposition,
                gaps: fakeOfferSearchResult.candidates[0]!.gaps,
                reason_codes: fakeOfferSearchResult.candidates[0]!.reason_codes,
                origin_evidence:
                  fakeOfferSearchResult.candidates[0]!.origin_evidence,
                checkout: fakeOfferSearchResult.candidates[0]!.checkout,
                publication_state: "provisional",
                durable: false,
                final_inclusion: "not_yet_determined",
              },
              action: {
                state: "REVIEW",
                actionable: false,
                permission: "withheld",
              },
            },
          },
        },
      },
    ]);
    expect(out).toEqual(fakeOfferSearchResult);
    expect(JSON.stringify(out)).not.toMatch(/ALLOW|SAFE_TO_QUOTE/);
  });

  it("offer_search labels a durable same-key replay without fabricating fresh acquisition progress", async () => {
    const replay = {
      type: "replay",
      sequence: 0,
      replayed_at: "2026-07-15T00:00:01.000Z",
      request_id: fakeOfferSearchRequest.request_id,
      request_digest: fakeOfferSearchResult.request_digest,
      authority: "research_only",
      action_state: "REVIEW",
    };
    const fetchImpl = (async () =>
      new Response(
        [
          `event: replay\nid: 0\ndata: ${JSON.stringify(replay)}\n\n`,
          `event: final\nid: 1\ndata: ${JSON.stringify(fakeOfferSearchResult)}\n\n`,
        ].join(""),
        {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        },
      )) as typeof fetch;
    const client = await connectClient(fetchImpl);
    const progress: Array<{ progress: number; message?: string }> = [];
    const res = await client.callTool(
      { name: "offer_search", arguments: fakeOfferSearchRequest },
      undefined,
      { onprogress: (update) => progress.push(update) },
    );

    expect(progress).toEqual([
      {
        progress: 0,
        message: "Offer Search replayed the completed review-only result.",
      },
    ]);
    expect(parseToolText(res)).toEqual(fakeOfferSearchResult);
  });

  it("offer_search rejects authority-bearing streamed progress before forwarding it", async () => {
    const drifted = {
      type: "accepted",
      sequence: 0,
      at: "2026-07-15T00:00:00.000Z",
      request_id: fakeOfferSearchRequest.request_id,
      message: "admitted",
      authority: "research_only",
      action_state: "ALLOW",
      details: {},
    };
    const fetchImpl = (async () =>
      new Response(
        `event: accepted\nid: 0\ndata: ${JSON.stringify(drifted)}\n\n`,
        {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        },
      )) as typeof fetch;
    const client = await connectClient(fetchImpl);
    const progress: unknown[] = [];
    const res = await client.callTool(
      { name: "offer_search", arguments: fakeOfferSearchRequest },
      undefined,
      { onprogress: (update) => progress.push(update) },
    );

    expect(progress).toEqual([]);
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(parseToolText(res)).toMatchObject({ error: "internal error" });
  });

  it("offer_search refuses drifted ALLOW or SAFE_TO_QUOTE output", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          ...fakeOfferSearchResult,
          action: { state: "SAFE_TO_QUOTE", reason_codes: [] },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch;
    const client = await connectClient(fetchImpl);
    const res = await client.callTool({
      name: "offer_search",
      arguments: fakeOfferSearchRequest,
    });

    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(parseToolText(res)).toMatchObject({ error: "internal error" });
  });

  it.each([
    (() => {
      const payload = { ...fakeOfferSearchResult } as Record<string, unknown>;
      delete payload.request_digest;
      return payload;
    })(),
    { ...fakeOfferSearchResult, request_digest: "sha256:not-a-digest" },
    { ...fakeOfferSearchResult, request_id: "foreign-request" },
  ])(
    "offer_search rejects a missing, malformed, or foreign JSON request binding",
    async (payload) => {
      const fetchImpl = (async () =>
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof fetch;
      const client = await connectClient(fetchImpl);
      const res = await client.callTool({
        name: "offer_search",
        arguments: fakeOfferSearchRequest,
      });

      expect((res as { isError?: boolean }).isError).toBe(true);
      expect(parseToolText(res)).toMatchObject({ error: "internal error" });
    },
  );

  it("offer_search rejects a foreign replay binding before forwarding progress", async () => {
    const replay = {
      type: "replay",
      sequence: 0,
      replayed_at: "2026-07-15T00:00:01.000Z",
      request_id: "foreign-request",
      request_digest: fakeOfferSearchResult.request_digest,
      authority: "research_only",
      action_state: "REVIEW",
    };
    const fetchImpl = (async () =>
      new Response(
        `event: replay\nid: 0\ndata: ${JSON.stringify(replay)}\n\n`,
        {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        },
      )) as typeof fetch;
    const client = await connectClient(fetchImpl);
    const progress: unknown[] = [];
    const res = await client.callTool(
      { name: "offer_search", arguments: fakeOfferSearchRequest },
      undefined,
      { onprogress: (update) => progress.push(update) },
    );

    expect(progress).toEqual([]);
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(parseToolText(res)).toMatchObject({ error: "internal error" });
  });

  it("offer_search_gate final-fences the exact persisted generation and withholds permission", async () => {
    let seen:
      | { path: string; key: string | null; body: Record<string, unknown> }
      | undefined;
    const fetchImpl = (async (input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      seen = {
        path: new URL(url).pathname,
        key: new Headers(init?.headers).get("idempotency-key"),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      };
      return new Response(JSON.stringify(fakeOfferSearchGateResult), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const client = await connectClient(fetchImpl);
    const res = await client.callTool({
      name: "offer_search_gate",
      arguments: fakeOfferSearchGateRequest,
    });
    const out = parseToolText(res);

    expect(seen).toEqual({
      path: "/v1/search-offers/gate",
      key: null,
      body: fakeOfferSearchGateRequest,
    });
    expect(out).toMatchObject({
      state: "current_review_only",
      disposition: "REVIEW",
      permission: "withheld",
      final_fence_checked: true,
    });
    expect(JSON.stringify(out)).not.toMatch(/ALLOW|SAFE_TO_QUOTE/);
  });

  it.each([
    { disposition: "ALLOW" },
    { permission: "granted" },
    { decision: "BLOCK" },
    { nested: { safe_to_quote: true } },
    { nested: { permission: "granted" } },
  ])("offer_search_gate refuses authority drift", async (drift) => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ ...fakeOfferSearchGateResult, ...drift }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    const client = await connectClient(fetchImpl);
    const res = await client.callTool({
      name: "offer_search_gate",
      arguments: fakeOfferSearchGateRequest,
    });

    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(parseToolText(res)).toMatchObject({ error: "internal error" });
  });

  it("propagates MCP cancellation into offer_search without retrying", async () => {
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
      { name: "offer_search", arguments: fakeOfferSearchRequest },
      undefined,
      { signal: controller.signal },
    );

    await started;
    controller.abort(new Error("caller cancelled"));
    await aborted;
    await pending.catch(() => undefined);
    expect(calls).toBe(1);
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

  it("currentness_verify threads `mode` and returns the tier + deep explanation", async () => {
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

  it("surfaces a zero-balance (402) as a clear out-of-credit error, not 'internal error'", async () => {
    const client = await connectClient(
      failingKavalFetch(
        402,
        "insufficient_balance",
        "out of credit — top up to continue",
      ),
    );
    const res = await client.callTool({
      name: "currentness_verify",
      arguments: { belief: "Jane Doe is VP Engineering at Acme" },
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
      name: "currentness_verify",
      arguments: { belief: "Jane Doe is VP Engineering at Acme" },
    });

    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(parseToolText(res)).toMatchObject({
      error: "request_ambiguous",
      idempotency_key: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
  });

  it("offer_search forwards current strict wire fields without widening authority", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify(REPRESENTATIVE_WIRE_RESULT), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    const client = await connectClient(fetchImpl);
    const res = await client.callTool({
      name: "offer_search",
      arguments: fakeOfferSearchRequest,
    });
    const out = parseToolText(res);

    expect(out as Record<string, unknown>).toMatchObject({
      effective_request_digest: `sha256:${"b".repeat(64)}`,
      identity_resolution: {
        resolution_state: "exact_variant",
        exact_identity: true,
      },
      rejected_explanations: [
        {
          contender: false,
          disposition: "rejected",
        },
      ],
      candidates: [
        {
          origin_evidence: {
            artifact: "rendered_page",
            version_receipt: "browser-renderer/2026-07-16.1",
          },
          checkout: {
            observation: {
              delivery_promise: {
                certainty: "estimated",
              },
            },
          },
        },
      ],
    });
    expect(JSON.stringify(out)).not.toContain("SAFE_TO_QUOTE");
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

  it("proof_audit builds an action-bound proof packet", async () => {
    const client = await connectClient();
    const res = await client.callTool({
      name: "proof_audit",
      arguments: {
        text: "Acme is eligible for a refund",
        as_of: "2026-07-10T20:00:00Z",
        intended_action: "Issue the refund",
        materiality: "critical",
        reversibility: "irreversible",
        false_allow_cost_usd: 12_000,
        record: { system: "billing", table: "refunds", id: "acme" },
      },
    });
    expect(parseToolText(res)).toMatchObject({
      proof_id: "proof_1",
      action_decision: { decision: "REVIEW" },
    });
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

  it("proof_gate surfaces staged enforcement for a current proof", async () => {
    const client = await connectClient();
    const res = await client.callTool({
      name: "proof_gate",
      arguments: {
        proof_id: "proof_1",
        material_claim_ids: ["claim_1"],
        threshold: {
          policy_id: "pricing-current",
          policy_version: "1.0.0",
          materiality: "low",
          maximum_false_allow_risk: 0.01,
          minimum_evidence_coverage: 0.95,
        },
        action: {
          description: "Display the current price",
          materiality: "low",
          reversibility: "reversible",
        },
      },
    });
    expect(parseToolText(res)).toMatchObject({
      proofId: "proof_1",
      decision: { decision: "ALLOW" },
      enforcement: {
        mode: "bounded",
        executionAllowed: true,
      },
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
});

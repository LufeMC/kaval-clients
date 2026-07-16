import { describe, expect, it, vi } from "vitest";
import { Kaval, KavalError } from "../src/index.js";
import type {
  CalibrationSupportIdentity,
  ClaimAssessment,
} from "../src/index.js";

type CalibrationSupportIsRequired = ClaimAssessment extends {
  calibration_support: CalibrationSupportIdentity;
}
  ? true
  : false;
const CALIBRATION_SUPPORT_IS_REQUIRED: CalibrationSupportIsRequired = true;

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

const DECISION = {
  id: "id_1",
  status: "stale",
  confidence: 0.94,
  reason: "a newer source names a different CEO",
  checked_at: "2026-06-25T00:00:00.000Z",
  evidence: [],
  act: false,
};

describe("Kaval", () => {
  it("types issued claim assessments with required calibration support identity", () => {
    expect(CALIBRATION_SUPPORT_IS_REQUIRED).toBe(true);
  });

  it("verify() posts to /v1/verify with bearer auth and returns the decision", async () => {
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
        return { json: DECISION };
      }),
    });

    const decision = await kaval.verify("Acme's CEO is Jane Doe");

    expect(seen?.url).toBe("https://api.usekaval.com/v1/verify");
    expect(seen?.auth).toBe("Bearer kv_live_abc");
    expect(seen?.idempotencyKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(seen?.body).toEqual({ belief: "Acme's CEO is Jane Doe" });
    expect(decision.act).toBe(false);
    expect(decision.status).toBe("stale");
  });

  it("verify() accepts a full input object (and omits undefined)", async () => {
    let body: unknown;
    const kaval = new Kaval({
      fetch: mockFetch((_u, init) => {
        body = JSON.parse(init?.body as string);
        return { json: { ...DECISION, act: true } };
      }),
    });
    await kaval.verify({
      belief: "x",
      minConfidence: 0.8,
      freshness_sla: "7d",
      context: undefined,
    });
    expect(body).toEqual({
      belief: "x",
      minConfidence: 0.8,
      freshness_sla: "7d",
    });
  });

  it("verify({ mode }) sends the tier and parses back tier + the deep explanation", async () => {
    let body: unknown;
    const explained = {
      ...DECISION,
      status: "current",
      act: true,
      tier: "deep",
      explanation: {
        content: "Confirmed by the team page [1].",
        citations: [{ url: "https://acme.com/team" }],
        confidence: "high",
      },
    };
    const kaval = new Kaval({
      fetch: mockFetch((_u, init) => {
        body = JSON.parse(init?.body as string);
        return { json: explained };
      }),
    });
    const decision = await kaval.verify({ belief: "x", mode: "deep" });
    expect(body).toEqual({ belief: "x", mode: "deep" });
    expect(decision.tier).toBe("deep");
    expect(decision.explanation?.citations[0]?.url).toBe(
      "https://acme.com/team",
    );
    expect(decision.explanation?.confidence).toBe("high");
  });

  it("scanStore() hits /v1/scan-store", async () => {
    let url: string | undefined;
    const kaval = new Kaval({
      fetch: mockFetch((u) => {
        url = u;
        return {
          json: {
            total: 2,
            summary: { current: 1, stale: 1 },
            riskiest: [],
            tier: "fast",
          },
        };
      }),
    });
    const report = await kaval.scanStore({ beliefs: ["a", "b"] });
    expect(url).toContain("/v1/scan-store");
    expect(report.total).toBe(2);
    expect(report.summary.stale).toBe(1);
  });

  it("scanStore({ mode }) sends the tier and parses back the tier the sweep ran at", async () => {
    let body: unknown;
    const kaval = new Kaval({
      fetch: mockFetch((_u, init) => {
        body = JSON.parse(init?.body as string);
        return {
          json: {
            total: 1,
            summary: { current: 1 },
            riskiest: [],
            tier: "deep",
          },
        };
      }),
    });
    const report = await kaval.scanStore({ beliefs: ["a"], mode: "deep" });
    expect(body).toEqual({ beliefs: ["a"], mode: "deep" });
    expect(report.tier).toBe("deep");
  });

  it("audit() posts the exact proof request and returns a typed proof packet", async () => {
    let seen: { url: string; key?: string; body: unknown } | undefined;
    const kaval = new Kaval({
      fetch: mockFetch((url, init) => {
        const headers = init?.headers as Record<string, string>;
        seen = {
          url,
          key: headers["idempotency-key"],
          body: JSON.parse(init?.body as string),
        };
        return {
          json: {
            proof_id: "proof_1",
            action_decision: { decision: "REVIEW" },
          },
        };
      }),
    });
    const proof = await kaval.audit(
      {
        text: "Acme is eligible for a refund",
        as_of: "2026-07-10T20:00:00Z",
        intended_action: "Issue the refund",
        materiality: "critical",
        reversibility: "irreversible",
        false_allow_cost_usd: 12_000,
        record: { system: "billing", table: "refunds", id: "acme" },
      },
      { idempotencyKey: "audit-operation-0001" },
    );
    expect(seen).toEqual({
      url: "https://api.usekaval.com/v1/audit",
      key: "audit-operation-0001",
      body: {
        text: "Acme is eligible for a refund",
        as_of: "2026-07-10T20:00:00Z",
        intended_action: "Issue the refund",
        materiality: "critical",
        reversibility: "irreversible",
        false_allow_cost_usd: 12_000,
        record: { system: "billing", table: "refunds", id: "acme" },
      },
    });
    expect(proof.proof_id).toBe("proof_1");
    expect(proof.action_decision.decision).toBe("REVIEW");
  });

  it("gateAction() posts one proof locator and exposes staged enforcement", async () => {
    let seen: { url: string; body: unknown } | undefined;
    const kaval = new Kaval({
      fetch: mockFetch((url, init) => {
        seen = { url, body: JSON.parse(init?.body as string) };
        return {
          json: {
            proofId: "proof_1",
            state: "current",
            decision: { decision: "ALLOW" },
            billingClass: "action_gate",
            proofReused: true,
            researchPerformed: false,
            latencyMs: 4,
            enforcement: {
              mode: "bounded",
              controlApplied: true,
              executionAllowed: true,
              wouldAllow: true,
              reason: "inside boundary",
            },
          },
        };
      }),
    });
    const input = {
      proof_id: "proof_1",
      material_claim_ids: ["claim_1"],
      threshold: {
        policy_id: "pricing-current",
        policy_version: "1.0.0",
        materiality: "low" as const,
        maximum_false_allow_risk: 0.01,
        minimum_evidence_coverage: 0.95,
      },
      action: {
        description: "Display the current price",
        materiality: "low" as const,
        reversibility: "reversible" as const,
      },
    };
    const result = await kaval.gateAction(input);
    expect(seen).toEqual({
      url: "https://api.usekaval.com/v1/gate",
      body: input,
    });
    expect(result.enforcement).toMatchObject({
      mode: "bounded",
      executionAllowed: true,
    });
  });

  it("respects a custom baseUrl and trims the trailing slash", async () => {
    let url: string | undefined;
    const kaval = new Kaval({
      baseUrl: "http://localhost:8787/",
      fetch: mockFetch((u) => {
        url = u;
        return { json: DECISION };
      }),
    });
    await kaval.check("x");
    expect(url).toBe("http://localhost:8787/v1/check");
  });

  it("throws KavalError on a non-2xx response", async () => {
    const kaval = new Kaval({
      fetch: mockFetch(() => ({
        status: 400,
        json: { error: { code: "bad_request" } },
      })),
    });
    await expect(kaval.verify("x")).rejects.toBeInstanceOf(KavalError);
  });

  it("check() throws KavalError on a non-2xx response", async () => {
    const kaval = new Kaval({
      fetch: mockFetch(() => ({
        status: 402,
        json: { error: { code: "insufficient_balance" } },
      })),
    });
    await expect(kaval.check("x")).rejects.toBeInstanceOf(KavalError);
  });

  it("accepts a caller idempotency key on every billable method", async () => {
    const seen: Array<{ path: string; key?: string }> = [];
    const kaval = new Kaval({
      fetch: mockFetch((url, init) => {
        seen.push({
          path: new URL(url).pathname,
          key: (init?.headers as Record<string, string>)?.["idempotency-key"],
        });
        return {
          json:
            new URL(url).pathname === "/v1/search-offers"
              ? {
                  schema_revision: 2,
                  request_id: "offer-request-1",
                  request_digest: `sha256:${"a".repeat(64)}`,
                  action: { state: "NEEDS_REVIEW", reason_codes: [] },
                  candidates: [],
                }
              : {},
        };
      }),
    });
    const requestOptions = { idempotencyKey: "logical-operation-0001" };

    await kaval.check("x", requestOptions);
    await kaval.verify("x", requestOptions);
    await kaval.extractAndCheck({ text: "x" }, requestOptions);
    await kaval.scanStore({ beliefs: ["x"] }, requestOptions);
    await kaval.monitor({ beliefs: ["x"] }, requestOptions);
    await kaval.searchOffers(
      {
        schema_revision: 1,
        request_id: "offer-request-1",
      } as Parameters<Kaval["searchOffers"]>[0],
      requestOptions,
    );
    await kaval.audit(
      { text: "x", as_of: "2026-07-10T20:00:00Z" },
      requestOptions,
    );
    await kaval.gateAction(
      {
        proof_id: "proof_1",
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
      requestOptions,
    );
    await kaval.kaval({ fact_type: "x" }, requestOptions);
    await kaval.kavalBatch([{ fact_type: "x" }], requestOptions);

    expect(seen.map(({ path }) => path)).toEqual([
      "/v1/check",
      "/v1/verify",
      "/v1/extract-and-check",
      "/v1/scan-store",
      "/v1/monitor",
      "/v1/search-offers",
      "/v1/audit",
      "/v1/gate",
      "/v1/kaval",
      "/v1/kaval-batch",
    ]);
    expect(seen.every(({ key }) => key === requestOptions.idempotencyKey)).toBe(
      true,
    );
  });

  it("generates unique UUIDs when global Web Crypto is unavailable on Node 18", async () => {
    const keys: string[] = [];
    vi.stubGlobal("crypto", undefined);
    try {
      const kaval = new Kaval({
        fetch: mockFetch((_url, init) => {
          keys.push(
            (init?.headers as Record<string, string>)["idempotency-key"]!,
          );
          return { json: DECISION };
        }),
      });

      await kaval.check("first");
      await kaval.check("second");
    } finally {
      vi.unstubAllGlobals();
    }

    expect(keys).toHaveLength(2);
    expect(new Set(keys)).toHaveLength(2);
    for (const key of keys) {
      expect(key).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    }
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
      return new Response(JSON.stringify(DECISION), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    await expect(
      new Kaval({ fetch: fetchImpl }).verify("x"),
    ).resolves.toMatchObject({
      id: "id_1",
    });
    expect(calls).toBe(2);
    expect(keys[0]).toBeTruthy();
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
        JSON.stringify(calls === 1 ? { error: { code } } : DECISION),
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

    const out = await new Kaval({ fetch: fetchImpl }).verify("x", {
      idempotencyKey: "caller-operation-0001",
    });
    expect(out.id).toBe("id_1");
    expect(calls).toBe(2);
    expect(keys).toEqual(["caller-operation-0001", "caller-operation-0001"]);
  });

  it("bounds ambiguous retries at two attempts", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(
        JSON.stringify({ error: { code: "idempotency_in_progress" } }),
        { status: 409, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    await expect(
      new Kaval({ fetch: fetchImpl }).check("x"),
    ).rejects.toMatchObject({
      status: 409,
      idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(calls).toBe(2);
  });

  it("exposes the generated key after a terminal transport ambiguity", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("connection reset");
    }) as typeof fetch;

    const error = await new Kaval({ fetch: fetchImpl })
      .check("x")
      .catch((value) => value);
    expect(error).toBeInstanceOf(TypeError);
    expect(error).toMatchObject({
      idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
  });

  it("cancels audit immediately without retrying and preserves the recovery key", async () => {
    let calls = 0;
    const fetchImpl = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      calls += 1;
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        const onAbort = () => reject(signal?.reason ?? new Error("aborted"));
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort, { once: true });
      });
    }) as typeof fetch;
    const controller = new AbortController();
    const pending = new Kaval({ fetch: fetchImpl, timeoutMs: null }).audit(
      { text: "x", as_of: "2026-07-10T20:00:00Z" },
      { signal: controller.signal, idempotencyKey: "cancel-audit-0001" },
    );
    controller.abort(new Error("caller cancelled"));
    await expect(pending).rejects.toMatchObject({
      message: "caller cancelled",
      idempotencyKey: "cancel-audit-0001",
    });
    expect(calls).toBe(1);
  });

  it("applies a per-call gate timeout without an ambiguous retry", async () => {
    let calls = 0;
    const fetchImpl = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      calls += 1;
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        const onAbort = () => reject(signal?.reason ?? new Error("aborted"));
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort, { once: true });
      });
    }) as typeof fetch;
    const pending = new Kaval({ fetch: fetchImpl }).gateAction(
      {
        proof_key: "proof-key:sha256:test",
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
      { timeoutMs: 5, idempotencyKey: "timeout-gate-0001" },
    );
    await expect(pending).rejects.toMatchObject({
      message: "kaval request timed out after 5ms",
      idempotencyKey: "timeout-gate-0001",
    });
    expect(calls).toBe(1);
  });

  it("does not retry a terminal API response", async () => {
    let calls = 0;
    const kaval = new Kaval({
      fetch: mockFetch(() => {
        calls += 1;
        return { status: 503, json: { error: { code: "unavailable" } } };
      }),
    });

    await expect(kaval.check("x")).rejects.toMatchObject({ status: 503 });
    expect(calls).toBe(1);
  });

  it("rejects a malformed 2xx response instead of returning null", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response("not-json", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const error = await new Kaval({ fetch: fetchImpl })
      .check("x")
      .catch((value) => value);
    expect(error).toBeInstanceOf(SyntaxError);
    expect(error).toMatchObject({
      idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(calls).toBe(1);
  });

  it("extractAndCheck() posts to /v1/extract-and-check and returns beliefs", async () => {
    let seen: { url: string; body: unknown } | undefined;
    const kaval = new Kaval({
      fetch: mockFetch((url, init) => {
        seen = { url, body: JSON.parse(init?.body as string) };
        return { json: { beliefs: [{ ...DECISION, belief: "a" }] } };
      }),
    });
    const out = await kaval.extractAndCheck({
      text: "a paragraph",
      freshness_sla: "7d",
    });
    expect(seen?.url).toBe("https://api.usekaval.com/v1/extract-and-check");
    expect(seen?.body).toEqual({ text: "a paragraph", freshness_sla: "7d" });
    expect(out.beliefs).toHaveLength(1);
    expect(out.beliefs[0]?.belief).toBe("a");
  });

  it("monitor() posts to /v1/monitor and returns the sweep result + state", async () => {
    let seen: { url: string; body: unknown } | undefined;
    const kaval = new Kaval({
      fetch: mockFetch((url, init) => {
        seen = { url, body: JSON.parse(init?.body as string) };
        return {
          json: {
            total: 2,
            summary: { current: 1, stale: 1 },
            riskiest: [],
            tier: "fast",
            checked_at: "2026-06-25T00:00:00.000Z",
            delivered: 1,
            state: { riskyKeys: ["k1"] },
          },
        };
      }),
    });
    const out = await kaval.monitor({
      beliefs: ["a", "b"],
      webhook: "https://hook.test",
    });
    expect(seen?.url).toBe("https://api.usekaval.com/v1/monitor");
    expect(seen?.body).toEqual({
      beliefs: ["a", "b"],
      webhook: "https://hook.test",
    });
    expect(out.delivered).toBe(1);
    expect(out.state.riskyKeys).toEqual(["k1"]);
  });

  it("reportOutcome() posts to /v1/report-outcome", async () => {
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
        return { json: { ok: true } };
      }),
    });
    const out = await kaval.reportOutcome({
      id: "id_1",
      kind: "relied_and_correct",
    });
    expect(seen?.url).toBe("https://api.usekaval.com/v1/report-outcome");
    expect(seen?.idempotencyKey).toBeUndefined();
    expect(seen?.body).toEqual({ id: "id_1", kind: "relied_and_correct" });
    expect(out.ok).toBe(true);
  });

  it("kaval() posts the structured request to /v1/kaval", async () => {
    let seen: { url: string; body: unknown } | undefined;
    const kaval = new Kaval({
      fetch: mockFetch((url, init) => {
        seen = { url, body: JSON.parse(init?.body as string) };
        return { json: DECISION };
      }),
    });
    const out = await kaval.kaval({
      fact_type: "person.works_at",
      subject: "Jane",
      object: "Acme",
    });
    expect(seen?.url).toBe("https://api.usekaval.com/v1/kaval");
    expect(seen?.body).toEqual({
      fact_type: "person.works_at",
      subject: "Jane",
      object: "Acme",
    });
    expect(out.status).toBe("stale");
  });

  it("kavalBatch() posts requests to /v1/kaval-batch (omitting undefined concurrency)", async () => {
    let seen: { url: string; body: unknown } | undefined;
    const kaval = new Kaval({
      fetch: mockFetch((url, init) => {
        seen = { url, body: JSON.parse(init?.body as string) };
        return { json: [DECISION] };
      }),
    });
    const out = await kaval.kavalBatch([{ fact_type: "x" }]);
    expect(seen?.url).toBe("https://api.usekaval.com/v1/kaval-batch");
    expect(seen?.body).toEqual({ requests: [{ fact_type: "x" }] });
    expect(out).toHaveLength(1);
  });

  it("health() GETs /health and returns the status", async () => {
    let url: string | undefined;
    const kaval = new Kaval({
      fetch: mockFetch((u) => {
        url = u;
        return { json: { ok: true, name: "kaval", version: "0.1.0" } };
      }),
    });
    const out = await kaval.health();
    expect(url).toBe("https://api.usekaval.com/health");
    expect(out.ok).toBe(true);
    expect(out.name).toBe("kaval");
  });

  it("health() throws KavalError on a non-2xx response", async () => {
    const kaval = new Kaval({
      fetch: mockFetch(() => ({
        status: 503,
        json: { error: { code: "unavailable" } },
      })),
    });
    await expect(kaval.health()).rejects.toBeInstanceOf(KavalError);
  });
});

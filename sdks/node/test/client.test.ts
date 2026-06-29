import { describe, expect, it } from "vitest";
import { Kaval, KavalError } from "../src/index.js";

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
  it("verify() posts to /v1/verify with bearer auth and returns the decision", async () => {
    let seen: { url: string; auth?: string; body: unknown } | undefined;
    const kaval = new Kaval({
      apiKey: "kv_live_abc",
      fetch: mockFetch((url, init) => {
        seen = {
          url,
          auth: (init?.headers as Record<string, string>)?.["authorization"],
          body: JSON.parse(init?.body as string),
        };
        return { json: DECISION };
      }),
    });

    const decision = await kaval.verify("Acme's CEO is Jane Doe");

    expect(seen?.url).toBe("https://api.usekaval.com/v1/verify");
    expect(seen?.auth).toBe("Bearer kv_live_abc");
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
    let seen: { url: string; body: unknown } | undefined;
    const kaval = new Kaval({
      fetch: mockFetch((url, init) => {
        seen = { url, body: JSON.parse(init?.body as string) };
        return { json: { ok: true } };
      }),
    });
    const out = await kaval.reportOutcome({
      id: "id_1",
      kind: "relied_and_correct",
    });
    expect(seen?.url).toBe("https://api.usekaval.com/v1/report-outcome");
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

import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Kaval } from "@usekaval/kaval";
import { describe, expect, it } from "vitest";
import { createMcpServer } from "../src/server.js";
import { fakeKavalFetch, parseToolText } from "./helpers/fake-api.js";

/**
 * MCP is a thin client now: a request goes MCP tool → `kaval` HTTP client → the hosted `/v1/*` API.
 * We inject a fake `fetch` that returns canned `/v1/*` responses, so this exercises the MCP layer
 * and the tool→client arg threading without touching the network or the (private) engine.
 *
 * For registry-shaped installs (packed tarballs, not workspace symlinks), see published-artifacts.test.ts.
 */
async function connectClient(): Promise<McpClient> {
  const kaval = new Kaval({ apiKey: "kv_live_test", fetch: fakeKavalFetch });
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
  it("discovers all agent-facing tools, hero tool first", async () => {
    const client = await connectClient();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "currentness_verify",
        "currentness_check",
        "currentness_extract_and_check",
        "currentness_scan_store",
        "currentness_monitor",
        "report_outcome",
      ]),
    );
    // The pre-action gate is registered first so agents reach for it at the act-moment.
    expect(names[0]).toBe("currentness_verify");
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

  it("extract_and_check finds the checkable beliefs in a paragraph", async () => {
    const client = await connectClient();
    const res = await client.callTool({
      name: "currentness_extract_and_check",
      arguments: { text: "Jane Doe is VP Eng at Acme. Acme has SOC 2." },
    });
    const out = parseToolText(res);
    expect(out.beliefs).toHaveLength(2);
  });
});

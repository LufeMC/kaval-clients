/**
 * Opt-in live test: every MCP tool → real /v1/* on the hosted API.
 * Run: KAVAL_API_KEY=kv_live_… pnpm test test/live-tools.test.ts
 */
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Kaval } from "@usekaval/kaval";
import { describe, expect, it } from "vitest";
import { createClientFromEnv } from "../src/env.js";
import { createMcpServer } from "../src/server.js";
import { parseToolText } from "./helpers/fake-api.js";

const apiKey = process.env.KAVAL_API_KEY;
const STATUSES = new Set([
  "current",
  "stale",
  "contradicted",
  "unsupported",
  "conflicting",
  "insufficient",
]);

async function connectLiveClient(): Promise<McpClient> {
  const kaval = apiKey
    ? new Kaval({ apiKey, baseUrl: process.env.KAVAL_BASE_URL })
    : createClientFromEnv();
  const server = createMcpServer(kaval);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new McpClient({ name: "live-tools", version: "0.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return client;
}

function expectToolOk(res: unknown) {
  expect((res as { isError?: boolean }).isError).not.toBe(true);
  return parseToolText(res);
}

describe.skipIf(!apiKey)("MCP live tools (hosted API)", () => {
  it("currentness_verify → /v1/verify returns a real decision", async () => {
    const client = await connectLiveClient();
    const out = expectToolOk(
      await client.callTool({
        name: "currentness_verify",
        arguments: {
          belief: "Tim Cook is the CEO of Apple",
          mode: "fast",
        },
      }),
    );
    expect(typeof out.id).toBe("string");
    expect(STATUSES.has(String(out.status))).toBe(true);
    expect(typeof (out as { act?: boolean }).act).toBe("boolean");
  }, 120_000);

  it("currentness_check → /v1/check returns a real verdict", async () => {
    const client = await connectLiveClient();
    const out = expectToolOk(
      await client.callTool({
        name: "currentness_check",
        arguments: {
          belief: "Satya Nadella is the CEO of Microsoft",
          freshness_sla: "30d",
        },
      }),
    );
    expect(typeof out.id).toBe("string");
    expect(STATUSES.has(String(out.status))).toBe(true);
  }, 120_000);

  it("currentness_extract_and_check → /v1/extract-and-check returns beliefs", async () => {
    const client = await connectLiveClient();
    const out = expectToolOk(
      await client.callTool({
        name: "currentness_extract_and_check",
        arguments: {
          text: "Tim Cook is CEO of Apple. Apple is headquartered in Cupertino.",
        },
      }),
    );
    expect(Array.isArray(out.beliefs)).toBe(true);
    expect(out.beliefs!.length).toBeGreaterThan(0);
  }, 180_000);

  it("currentness_scan_store → /v1/scan-store returns a sweep summary", async () => {
    const client = await connectLiveClient();
    const out = expectToolOk(
      await client.callTool({
        name: "currentness_scan_store",
        arguments: {
          beliefs: [
            "Tim Cook is the CEO of Apple",
            "Satya Nadella is the CEO of Microsoft",
          ],
          mode: "fast",
        },
      }),
    );
    expect(typeof (out as { total?: number }).total).toBe("number");
    expect(typeof out.tier).toBe("string");
    expect(Array.isArray((out as { riskiest?: unknown[] }).riskiest)).toBe(
      true,
    );
  }, 180_000);

  it("currentness_monitor → /v1/monitor returns delivery + state", async () => {
    const client = await connectLiveClient();
    const out = expectToolOk(
      await client.callTool({
        name: "currentness_monitor",
        arguments: {
          beliefs: ["Tim Cook is the CEO of Apple"],
          mode: "fast",
          webhook: "https://example.com/hooks/stale",
        },
      }),
    );
    expect(typeof (out as { delivered?: number }).delivered).toBe("number");
    expect(
      (out as { state?: { riskyKeys?: unknown[] } }).state?.riskyKeys,
    ).toBeDefined();
  }, 180_000);

  it("report_outcome → /v1/report-outcome accepts an id from verify", async () => {
    const client = await connectLiveClient();
    const verify = expectToolOk(
      await client.callTool({
        name: "currentness_verify",
        arguments: {
          belief: "Tim Cook is the CEO of Apple",
          mode: "fast",
        },
      }),
    );
    expect(typeof verify.id).toBe("string");

    const out = expectToolOk(
      await client.callTool({
        name: "report_outcome",
        arguments: {
          id: verify.id!,
          kind: "relied_and_correct",
          note: "mcp live-tools test",
        },
      }),
    );
    expect((out as { ok?: boolean }).ok).toBe(true);
  }, 180_000);
});

/**
 * Conformance/smoke against npm-packed `kaval` + `@usekaval/mcp` — what registry consumers resolve,
 * not the pnpm workspace symlink.
 */
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fakeKavalFetch, parseToolText } from "./helpers/fake-api.js";
import {
  installPackedTarballs,
  isWorkspaceLinkedPackage,
  type PackedInstall,
} from "./helpers/pack-and-install.js";

const kavalWorkspaceDir = fileURLToPath(
  new URL("../../../sdks/node", import.meta.url),
);

describe("published tarballs (not workspace-linked kaval)", () => {
  let install: PackedInstall;

  beforeAll(async () => {
    install = await installPackedTarballs();
  }, 120_000);

  afterAll(() => {
    install?.cleanup();
  });

  it("installs kaval from the packed tarball, not the workspace link", () => {
    expect(
      isWorkspaceLinkedPackage(install.kavalRealPath, kavalWorkspaceDir),
    ).toBe(false);
  });

  it("starts the packed MCP bin and lists tools over stdio", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [install.mcpBin],
      env: { PATH: process.env.PATH ?? "", KAVAL_API_KEY: "kv_live_test" },
    });
    const client = new McpClient({
      name: "published-bin-smoke",
      version: "0.0.0",
    });

    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(
        expect.arrayContaining([
          "currentness_verify",
          "currentness_check",
          "currentness_extract_and_check",
          "currentness_scan_store",
          "currentness_monitor",
          "report_outcome",
        ]),
      );
    } finally {
      await client.close();
    }
  }, 30_000);

  it("conformance: packed kaval + MCP server thread tool args to /v1/verify", async () => {
    const { Kaval } = (await import(
      install.kavalEntry
    )) as typeof import("kaval");
    const { createMcpServer } = (await import(
      install.mcpServerEntry
    )) as typeof import("../src/server.js");

    const kaval = new Kaval({ apiKey: "kv_live_test", fetch: fakeKavalFetch });
    const server = createMcpServer(kaval);
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new McpClient({
      name: "published-conformance",
      version: "0.0.0",
    });
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const res = await client.callTool({
      name: "currentness_verify",
      arguments: { belief: "Jane Doe is VP Engineering at Acme", mode: "deep" },
    });
    const out = parseToolText(res);
    expect(out.tier).toBe("deep");
    expect(out.explanation?.citations?.[0]?.url).toBe("https://acme.com/team");
  });
});

/**
 * Conformance/smoke against npm-packed `@usekaval/kaval` + `@usekaval/mcp` — what registry consumers resolve,
 * not the pnpm workspace symlink.
 */
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  fakeAddSourceResult,
  fakeCheckReceipt,
  fakeCheckResult,
  fakeKavalFetch,
  fakeReceiptId,
  fakeVerifyReceipt,
  fakeVerifyRequest,
  parseToolText,
} from "./helpers/fake-api.js";
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

  it("starts the packed MCP bin and lists the verification tools over stdio", async () => {
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
      const names = tools.map((t) => t.name);
      expect(names).toEqual(
        expect.arrayContaining([
          "check",
          "get_receipt",
          "add_source",
          "list_sources",
          "remove_source",
          "report_outcome",
          "verify",
        ]),
      );
      expect(names.join(" ")).not.toMatch(/offer|product/);
    } finally {
      await client.close();
    }
  }, 30_000);

  it("conformance: packed kaval + MCP server expose check, the source registry, and the verify alias", async () => {
    const { Kaval } = (await import(
      install.kavalEntry
    )) as typeof import("@usekaval/kaval");
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

    const checkResult = await client.callTool({
      name: "check",
      arguments: {
        action:
          "Approve this prior-authorization request at the in-network rate",
        context: "payer: Aetna; CPT 12345",
      },
    });
    const check = parseToolText(checkResult);
    expect(check).toEqual(fakeCheckResult);
    expect(check.decision).toBe("BLOCK");
    expect(check.receipt?.id).toBe(fakeReceiptId);

    // get_receipt calls straight through to the packed client's getReceipt — a method the MCP
    // surface now depends on, so a tarball published without it must fail here.
    const receiptResult = await client.callTool({
      name: "get_receipt",
      arguments: { receipt_id: check.receipt!.id! },
    });
    expect(parseToolText(receiptResult).receipt).toEqual(fakeCheckReceipt);

    const sourceResult = await client.callTool({
      name: "add_source",
      arguments: {
        kind: "entity",
        name: "Aetna",
        intent: "payer policy bulletins",
      },
    });
    expect(parseToolText(sourceResult)).toEqual(fakeAddSourceResult);

    const listResult = await client.callTool({
      name: "list_sources",
      arguments: {},
    });
    expect(parseToolText(listResult).sources).toHaveLength(1);

    const verifyResult = await client.callTool({
      name: "verify",
      arguments: fakeVerifyRequest,
    });
    const verify = parseToolText(verifyResult);
    expect(verify).toEqual(fakeVerifyReceipt);
    expect(verify.receipt?.packet?.signature?.algorithm).toBe("Ed25519");
  });
});

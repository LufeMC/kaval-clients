/**
 * Conformance/smoke against npm-packed `@usekaval/kaval` + `@usekaval/mcp` — what registry consumers resolve,
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
          "product_research",
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
    } finally {
      await client.close();
    }
  }, 30_000);

  it("conformance: packed kaval + MCP server expose currentness and proof protocols", async () => {
    const { Kaval } = (await import(
      install.kavalEntry
    )) as typeof import("@usekaval/kaval");
    const { createMcpServer } = (await import(
      install.mcpServerEntry
    )) as typeof import("../src/server.js");

    const kaval = new Kaval({ apiKey: "kv_live_test", fetch: fakeKavalFetch });
    const directResearch = await kaval.researchProducts({
      query: "cordless framing nailer",
    });
    expect(directResearch.authority).toEqual({
      mode: "review_only",
      action_authorized: false,
      permission: "withheld",
    });
    expect(directResearch.unverified_discoveries[0]).toMatchObject({
      title: "Unverified web result",
      listing_kind: "unknown",
    });

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

    const researchResult = await client.callTool({
      name: "product_research",
      arguments: { query: "cordless framing nailer" },
    });
    const research = parseToolText(researchResult);
    expect(research.authority).toEqual({
      mode: "review_only",
      action_authorized: false,
      permission: "withheld",
    });
    expect(research.unverified_discoveries?.[0]).toMatchObject({
      title: "Unverified web result",
      listing_kind: "unknown",
    });

    const verifyResult = await client.callTool({
      name: "currentness_verify",
      arguments: { belief: "Jane Doe is VP Engineering at Acme", mode: "deep" },
    });
    const verify = parseToolText(verifyResult);
    expect(verify.tier).toBe("deep");
    expect(verify.explanation?.citations?.[0]?.url).toBe(
      "https://acme.com/team",
    );

    const auditResult = await client.callTool({
      name: "proof_audit",
      arguments: {
        text: "Acme is eligible for a refund",
        as_of: "2026-07-10T20:00:00Z",
        intended_action: "Issue the refund",
        materiality: "critical",
        reversibility: "irreversible",
      },
    });
    const audit = parseToolText(auditResult);
    expect(audit.proof_id).toBe("proof_1");
    expect(audit.action_decision?.decision).toBe("REVIEW");

    const gateResult = await client.callTool({
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
    const gate = parseToolText(gateResult);
    expect(gate.proofId).toBe("proof_1");
    expect(gate.enforcement?.executionAllowed).toBe(true);
  });
});

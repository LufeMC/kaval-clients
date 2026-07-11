import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

type PackageJson = { name: string; version: string; mcpName?: string };
type ServerJson = {
  name: string;
  version: string;
  packages: Array<{ identifier: string; version: string }>;
};

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const json = <T>(path: string): T =>
  JSON.parse(readFileSync(join(repoRoot, path), "utf8")) as T;

describe("release version metadata", () => {
  it("keeps every published client and MCP registry manifest on one version", () => {
    const node = json<PackageJson>("sdks/node/package.json");
    const mcp = json<PackageJson>("packages/mcp/package.json");
    const server = json<ServerJson>("packages/mcp/server.json");
    const pyproject = readFileSync(
      join(repoRoot, "sdks/python/pyproject.toml"),
      "utf8",
    );
    const pythonVersion = pyproject.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
    const mcpSource = readFileSync(
      join(repoRoot, "packages/mcp/src/server.ts"),
      "utf8",
    );

    expect(node.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect([
      mcp.version,
      server.version,
      server.packages[0]?.version,
      pythonVersion,
    ]).toEqual([node.version, node.version, node.version, node.version]);
    expect(server.name).toBe(mcp.mcpName);
    expect(server.packages[0]?.identifier).toBe(mcp.name);
    expect(mcpSource).toContain(
      `new McpServer({ name: "kaval", version: "${node.version}" })`,
    );
  });
});

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const binPath = resolve(pkgRoot, "dist/bin.js");

/**
 * Proves the published artifact works as plain `tsc` output: build, then spawn `dist/bin.js` as a real
 * subprocess and drive it over stdio. `listTools` makes no network call, so a dummy `KAVAL_API_KEY` is
 * enough to start the thin client — this asserts the CLI boots and exposes the tools end-to-end.
 */
describe("kaval-mcp bin (smoke)", () => {
  beforeAll(async () => {
    // Rebuild from current source so the test always reflects it (tsc only — no bundler anymore).
    await execFileAsync("pnpm", ["exec", "tsc", "-p", "tsconfig.build.json"], {
      cwd: pkgRoot,
    });
    expect(existsSync(binPath)).toBe(true);
  }, 60_000);

  it("starts and exposes the currentness tools over stdio", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [binPath],
      // A dummy key satisfies createClientFromEnv(); listTools never reaches the network.
      env: { PATH: process.env.PATH ?? "", KAVAL_API_KEY: "kv_live_test" },
    });
    const client = new McpClient({ name: "bin-smoke", version: "0.0.0" });

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
});

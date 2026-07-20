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
 * Registry-shaped installs (packed tarballs) are covered by published-artifacts.test.ts.
 */
describe("kaval-mcp bin (smoke)", () => {
  beforeAll(async () => {
    // Rebuild from current source so the test always reflects it (tsc only — no bundler anymore).
    await execFileAsync("pnpm", ["exec", "tsc", "-p", "tsconfig.build.json"], {
      cwd: pkgRoot,
    });
    expect(existsSync(binPath)).toBe(true);
  }, 60_000);

  it("exits with a clear message when KAVAL_API_KEY is missing", async () => {
    try {
      await execFileAsync(process.execPath, [binPath], {
        env: { PATH: process.env.PATH ?? "" },
      });
      expect.fail("expected bin to exit non-zero without KAVAL_API_KEY");
    } catch (error: unknown) {
      const execError = error as NodeJS.ErrnoException & { stderr?: string };
      expect(execError.code).toBe(1);
      const stderr = execError.stderr ?? "";
      expect(stderr).toContain("KAVAL_API_KEY is required");
      expect(stderr).not.toMatch(/\bat createClientFromEnv\b/);
      expect(stderr.trim()).toBe(
        "KAVAL_API_KEY is required — create a key at https://usekaval.com and set KAVAL_API_KEY.",
      );
    }
  });

  it("starts and exposes the verification tools over stdio", async () => {
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
      const names = tools.map((t) => t.name);
      expect(names).toEqual(
        expect.arrayContaining([
          "verify",
          "proof_audit",
          "proof_gate",
          "currentness_verify",
          "currentness_check",
          "currentness_extract_and_check",
          "currentness_scan_store",
          "currentness_monitor",
          "report_outcome",
        ]),
      );
      expect(names.join(" ")).not.toMatch(/offer|product/);
    } finally {
      await client.close();
    }
  }, 30_000);
});

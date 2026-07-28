import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClientFromEnv, isMcpConfigError } from "../src/env.js";

const packageDir = new URL("../", import.meta.url);
const read = (name: string): string =>
  readFileSync(fileURLToPath(new URL(name, packageDir)), "utf8");

/** The two deadlines this client has to sit between, in ms. */
const MCP_CLIENT_CANCELS_AT = 60_000; // @modelcontextprotocol/sdk DEFAULT_REQUEST_TIMEOUT_MSEC
const RESEARCH_BUDGET_SENT = 45_000; // the max_wait_ms server.ts asks the API for

describe("createClientFromEnv", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("refuses to start without a key, in words a human can act on", () => {
    expect(() => createClientFromEnv({})).toThrow(/KAVAL_API_KEY is required/);
    try {
      createClientFromEnv({});
    } catch (error) {
      expect(isMcpConfigError(error)).toBe(true);
    }
  });

  it("outlives the research it asks for and still gives up inside the MCP envelope", async () => {
    // The deadline has to sit strictly between the two: shorter than the budget `check` sends and
    // it aborts research it paid for, longer than the MCP caller's own 60s and the agent gets a
    // caller-side cancellation instead of an error it can act on. The client's default is sized for
    // direct HTTP callers, who have neither constraint, so inheriting it is wrong in both
    // directions depending on which way it moves.
    vi.useFakeTimers();
    const signals: Array<AbortSignal | undefined | null> = [];
    vi.stubGlobal("fetch", ((_input: unknown, init?: RequestInit) => {
      signals.push(init?.signal);
      return new Promise<Response>(() => {});
    }) as typeof fetch);

    const client = createClientFromEnv({ KAVAL_API_KEY: "kv_live_test" });
    void client.check({ action: "Issue the refund" }).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(1);
    const signal = signals[0];
    expect(signal).toBeDefined();

    await vi.advanceTimersByTimeAsync(RESEARCH_BUDGET_SENT);
    expect(signal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(MCP_CLIENT_CANCELS_AT - 1_000);
    expect(signal?.aborted).toBe(true);
  });
});

describe("registry manifests", () => {
  // A Smithery or MCP-registry install can only set what the manifest declares. KAVAL_BASE_URL was
  // readable here and declared nowhere, so a registry install was hard-wired to the hosted API —
  // with no path at all to the self-hosted deployment SELFHOST.md tells operators to point at.
  it("declare every environment variable the client actually reads", () => {
    const declared = [...read("src/env.ts").matchAll(/env\.(KAVAL_[A-Z_]+)/g)]
      .map((match) => match[1]!)
      .sort();
    expect(declared).toEqual(["KAVAL_API_KEY", "KAVAL_BASE_URL"]);

    const serverJson = read("server.json");
    const smithery = read("smithery.yaml");
    for (const name of declared) {
      expect(serverJson, `server.json omits ${name}`).toContain(`"${name}"`);
      expect(smithery, `smithery.yaml omits ${name}`).toContain(name);
    }
  });
});

/**
 * Ported verbatim from the standalone verifier's `test/cli.test.mjs` (node:test).
 * Every assertion is the same; only the runner and the artifact path changed — the `dist` file
 * these spawn is exactly what the `kaval-receipt-verify` bin points at.
 */

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { beforeAll, expect, test } from "vitest";
import { distCli, ensureDistBuilt } from "./dist-build.js";

const execute = promisify(execFile);
const vectorsUrl = new URL(
  "../fixtures/verify-vectors/ed25519-receipt-vectors.json",
  import.meta.url,
);
const vectorsFile = fileURLToPath(vectorsUrl);
const vectors = JSON.parse(readFileSync(vectorsUrl, "utf8"));

beforeAll(() => {
  ensureDistBuilt();
}, 120_000);

test("CLI verifies a shared-receipt wrapper with an offline keyset", async () => {
  const directory = await mkdtemp(`${tmpdir()}/kaval-receipt-verifier-`);
  try {
    const receiptPath = `${directory}/receipt.json`;
    await writeFile(
      receiptPath,
      JSON.stringify({ run: { packet: vectors.signed_receipt } }),
      "utf8",
    );
    const { stdout } = await execute(
      process.execPath,
      [
        distCli,
        "verify",
        receiptPath,
        "--keyset",
        vectorsFile,
        "--at",
        "2026-07-20T12:00:00.000Z",
        "--compact",
      ],
      { encoding: "utf8" },
    );
    const result = JSON.parse(stdout);
    expect(result.accepted).toBe(true);
    expect(result.cryptographic.valid).toBe(true);
    expect(result.freshness.status).toBe("fresh");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI can require freshness without conflating it with signature validity", async () => {
  const directory = await mkdtemp(`${tmpdir()}/kaval-receipt-verifier-`);
  try {
    const receiptPath = `${directory}/receipt.json`;
    await writeFile(
      receiptPath,
      JSON.stringify(vectors.signed_receipt),
      "utf8",
    );
    const error = await execute(
      process.execPath,
      [
        distCli,
        receiptPath,
        "--keyset",
        vectorsFile,
        "--at",
        "2026-07-22T00:00:00.000Z",
        "--require-fresh",
        "--compact",
      ],
      { encoding: "utf8" },
    ).then(
      () => {
        throw new Error("the CLI exited 0 on an expired receipt");
      },
      (thrown: NodeJS.ErrnoException & { stdout: string }) => thrown,
    );
    const result = JSON.parse(error.stdout);
    expect(result.cryptographic.valid).toBe(true);
    expect(result.accepted).toBe(true);
    expect(result.freshness.status).toBe("expired");
    expect(error.code).toBe(1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI rejects a nonexistent --at calendar day before freshness evaluation", async () => {
  const directory = await mkdtemp(`${tmpdir()}/kaval-receipt-verifier-`);
  try {
    const receiptPath = `${directory}/receipt.json`;
    await writeFile(
      receiptPath,
      JSON.stringify(vectors.signed_receipt),
      "utf8",
    );
    const error = await execute(
      process.execPath,
      [
        distCli,
        receiptPath,
        "--keyset",
        vectorsFile,
        "--at",
        "2026-02-29T00:00:00.000Z",
        "--require-fresh",
        "--compact",
      ],
      { encoding: "utf8" },
    ).then(
      () => {
        throw new Error("the CLI exited 0 on an impossible --at");
      },
      (thrown: NodeJS.ErrnoException & { stdout: string }) => thrown,
    );
    const result = JSON.parse(error.stdout);
    expect(result.accepted).toBe(false);
    expect(result.error.code).toBe("verification_failed");
    expect(result.error.message).toMatch(/verification time is invalid/u);
    expect(error.code).toBe(2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

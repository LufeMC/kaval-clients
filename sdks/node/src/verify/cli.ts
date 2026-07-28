#!/usr/bin/env node

import { readFile, stat } from "node:fs/promises";
import process from "node:process";
import { parseJsonStrict } from "./canonicalize.js";
import { discoverVerificationKeyDocument } from "./discovery.js";
import { extractReceipt, verifyReceipt } from "./verify.js";

const MAX_RECEIPT_BYTES = 8 * 1_024 * 1_024;
const MAX_OFFLINE_KEYSET_BYTES = 1 * 1_024 * 1_024;

const HELP = `Usage:
  kaval-receipt-verify verify <receipt.json|-> --keyset <keys.json> [options]
  kaval-receipt-verify verify <receipt.json|-> --key-url <https-url> [options]

Options:
  --keyset <path>            Offline per-key document or keyset (recommended for reproducibility)
  --key-url <url>            HTTPS per-key endpoint or keyset endpoint
  --at <RFC3339>             Evaluate freshness at an explicit time
  --require-fresh            Exit non-zero unless freshness is "fresh"
  --allow-http-loopback      Permit http://localhost/127.0.0.0/8/::1 for local development
  --compact                  Emit compact JSON
  -h, --help                 Show this help

Exit status 0 means the signature is valid and the key is trusted. Freshness is reported
separately unless --require-fresh is supplied.
`;

interface Arguments {
  receiptPath: string;
  keysetPath?: string;
  keyUrl?: string;
  at?: string;
  requireFresh: boolean;
  allowHttpLoopback: boolean;
  compact: boolean;
}

function argumentError(message: string): never {
  throw new Error(`${message}\n\n${HELP}`);
}

function parseArguments(argv: string[]): Arguments | null {
  if (argv.includes("--help") || argv.includes("-h")) return null;
  const values = [...argv];
  if (values[0] === "verify") values.shift();
  const receiptPath = values.shift();
  if (!receiptPath || receiptPath.startsWith("--"))
    argumentError("a receipt path is required");
  const result: Arguments = {
    receiptPath,
    requireFresh: false,
    allowHttpLoopback: false,
    compact: false,
  };
  while (values.length > 0) {
    const flag = values.shift()!;
    if (flag === "--require-fresh") result.requireFresh = true;
    else if (flag === "--allow-http-loopback") result.allowHttpLoopback = true;
    else if (flag === "--compact") result.compact = true;
    else if (flag === "--keyset" || flag === "--key-url" || flag === "--at") {
      const value = values.shift();
      if (!value || value.startsWith("--"))
        argumentError(`${flag} requires a value`);
      if (flag === "--keyset") result.keysetPath = value;
      else if (flag === "--key-url") result.keyUrl = value;
      else result.at = value;
    } else argumentError(`unknown option ${flag}`);
  }
  if ((result.keysetPath ? 1 : 0) + (result.keyUrl ? 1 : 0) !== 1) {
    argumentError("choose exactly one of --keyset or --key-url");
  }
  return result;
}

async function boundedFile(
  path: string,
  maximumBytes: number,
): Promise<string> {
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error(`${path} is not a regular file`);
  if (metadata.size > maximumBytes)
    throw new Error(`${path} exceeds the ${maximumBytes}-byte limit`);
  return readFile(path, "utf8");
}

async function boundedStdin(maximumBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > maximumBytes)
      throw new Error(`stdin exceeds the ${maximumBytes}-byte limit`);
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function signatureKeyId(receipt: unknown): string {
  if (
    receipt === null ||
    typeof receipt !== "object" ||
    Array.isArray(receipt) ||
    !("signature" in receipt)
  ) {
    throw new Error("receipt signature is missing");
  }
  const signature = (receipt as Record<string, unknown>)["signature"];
  if (
    signature === null ||
    typeof signature !== "object" ||
    Array.isArray(signature) ||
    typeof (signature as Record<string, unknown>)["key_id"] !== "string"
  ) {
    throw new Error("receipt signature key_id is missing");
  }
  return (signature as Record<string, string>)["key_id"]!;
}

function print(value: unknown, compact: boolean): void {
  process.stdout.write(
    `${JSON.stringify(value, null, compact ? undefined : 2)}\n`,
  );
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  if (!args) {
    process.stdout.write(HELP);
    return;
  }
  const receiptText =
    args.receiptPath === "-"
      ? await boundedStdin(MAX_RECEIPT_BYTES)
      : await boundedFile(args.receiptPath, MAX_RECEIPT_BYTES);
  const receipt = extractReceipt(parseJsonStrict(receiptText));
  const keyId = signatureKeyId(receipt);
  const keyDocument =
    args.keysetPath !== undefined
      ? parseJsonStrict(
          await boundedFile(args.keysetPath, MAX_OFFLINE_KEYSET_BYTES),
        )
      : await discoverVerificationKeyDocument(args.keyUrl!, keyId, {
          allow_http_loopback: args.allowHttpLoopback,
        });
  const result = verifyReceipt(receipt, keyDocument, {
    ...(args.at ? { at: args.at } : {}),
  });
  print(result, args.compact);
  if (
    !result.accepted ||
    (args.requireFresh && result.freshness.status !== "fresh")
  ) {
    process.exitCode = 1;
  }
}

try {
  await main();
} catch (error) {
  print(
    {
      contract_version: "1",
      accepted: false,
      error: {
        code: "verification_failed",
        message: (error as Error).message,
      },
    },
    process.argv.includes("--compact"),
  );
  process.exitCode = 2;
}

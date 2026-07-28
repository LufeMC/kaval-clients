/**
 * Live HTTPS key discovery. This is the ONLY module in the verifier that touches the network, and
 * it is deliberately NOT reachable from the `@usekaval/kaval/verify` entry point — import it from
 * `@usekaval/kaval/verify/discovery` when you want it. Keeping it on its own subpath is what lets
 * `verify` promise an import graph with no network code in it at all, which is the property an
 * offline auditor is relying on.
 */

import { parseJsonStrict } from "./canonicalize.js";
import { verificationKeyFromDocument } from "./key-document.js";
import type { JsonValue } from "./types.js";

/** Lives here rather than in `types.ts` so the offline entry point never references `fetch`. */
export interface DiscoveryOptions {
  fetch?: typeof globalThis.fetch;
  timeout_ms?: number;
  max_response_bytes?: number;
  allow_http_loopback?: boolean;
}

export const DEFAULT_DISCOVERY_TIMEOUT_MS = 5_000;
export const MAX_DISCOVERY_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_KEY_DOCUMENT_BYTES = 256 * 1_024;
export const MAX_KEY_DOCUMENT_BYTES = 1_024 * 1_024;

function loopback(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === "localhost" ||
    host === "[::1]" ||
    host === "::1" ||
    /^127(?:\.[0-9]{1,3}){3}$/u.test(host)
  );
}

function discoveryUrl(raw: string, allowHttpLoopback: boolean): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("key discovery URL is invalid");
  }
  if (url.username || url.password)
    throw new Error("key discovery URL must not contain credentials");
  if (url.hash)
    throw new Error("key discovery URL must not contain a fragment");
  if (
    url.protocol !== "https:" &&
    !(allowHttpLoopback && url.protocol === "http:" && loopback(url.hostname))
  ) {
    throw new Error("key discovery requires HTTPS");
  }
  return url;
}

async function boundedBody(
  response: Response,
  maximumBytes: number,
): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0 || length > maximumBytes) {
      throw new Error("key discovery response exceeds the byte limit");
    }
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new Error("key discovery response exceeds the byte limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

/**
 * Fetch a per-key document or keyset with bounded HTTPS I/O and verify that it contains the
 * requested immutable key ID. Redirects are refused so discovery cannot silently change trust roots.
 */
export async function discoverVerificationKeyDocument(
  rawUrl: string,
  keyId: string,
  options: DiscoveryOptions = {},
): Promise<JsonValue> {
  const timeoutMs = options.timeout_ms ?? DEFAULT_DISCOVERY_TIMEOUT_MS;
  const maximumBytes =
    options.max_response_bytes ?? DEFAULT_MAX_KEY_DOCUMENT_BYTES;
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 100 ||
    timeoutMs > MAX_DISCOVERY_TIMEOUT_MS
  ) {
    throw new Error(
      `discovery timeout_ms must be between 100 and ${MAX_DISCOVERY_TIMEOUT_MS}`,
    );
  }
  if (
    !Number.isInteger(maximumBytes) ||
    maximumBytes < 1_024 ||
    maximumBytes > MAX_KEY_DOCUMENT_BYTES
  ) {
    throw new Error(
      `discovery max_response_bytes must be between 1024 and ${MAX_KEY_DOCUMENT_BYTES}`,
    );
  }
  if (typeof keyId !== "string" || !keyId.trim() || keyId.length > 128) {
    throw new Error("discovery key ID is invalid");
  }
  const url = discoveryUrl(rawUrl, options.allow_http_loopback === true);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function")
    throw new Error("this runtime does not provide fetch");
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("key discovery timed out")),
    timeoutMs,
  );
  timer.unref?.();
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": "@usekaval/kaval-receipt-verify/1",
      },
      redirect: "manual",
      signal: controller.signal,
    });
    if (response.status >= 300 && response.status < 400) {
      throw new Error("key discovery redirects are not permitted");
    }
    if (response.status !== 200) {
      throw new Error(`key discovery returned HTTP ${response.status}`);
    }
    const contentType = response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    if (
      contentType !== undefined &&
      contentType !== "" &&
      contentType !== "application/json" &&
      !contentType.endsWith("+json")
    ) {
      throw new Error(
        `key discovery returned unsupported content type ${contentType}`,
      );
    }
    const bytes = await boundedBody(response, maximumBytes);
    let json: JsonValue;
    try {
      json = parseJsonStrict(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
    } catch (error) {
      throw new Error(
        `key discovery returned invalid JSON: ${(error as Error).message}`,
      );
    }
    if (!verificationKeyFromDocument(json, keyId)) {
      throw new Error(
        `key discovery response does not contain requested key ID ${keyId}`,
      );
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

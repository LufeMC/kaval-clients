/**
 * Ported verbatim from the standalone verifier's `test/discovery.test.mjs` (node:test).
 * Every assertion is the same; only the runner and the import path changed.
 *
 * Discovery is the ONE part of the verifier that talks to the network, so it deliberately does not
 * live behind `@usekaval/kaval/verify` — it has its own `@usekaval/kaval/verify/discovery` subpath,
 * and `no-network.test.ts` proves the offline entry point cannot reach it.
 */

import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { discoverVerificationKeyDocument } from "../../src/verify/discovery.js";
import { verificationKeyFromDocument } from "../../src/verify/index.js";

const vectors = JSON.parse(
  readFileSync(
    new URL(
      "../fixtures/verify-vectors/ed25519-receipt-vectors.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const keyId = "vector-ed25519-001";

function jsonResponse(
  value: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(value), {
    status: init.status ?? 200,
    headers: {
      "content-type": "application/json",
      ...init.headers,
    },
  });
}

test("bounded HTTPS discovery resolves an exact key ID", async () => {
  let observed: { url: string; options: RequestInit | undefined } | undefined;
  const document = await discoverVerificationKeyDocument(
    "https://keys.example.test/v1/proof-verification-keys",
    keyId,
    {
      fetch: async (url, options) => {
        observed = { url: String(url), options };
        return jsonResponse({ keyset: vectors.keyset });
      },
    },
  );
  expect(observed?.url).toBe(
    "https://keys.example.test/v1/proof-verification-keys",
  );
  expect(observed?.options?.redirect).toBe("manual");
  expect(verificationKeyFromDocument(document, keyId)?.key_id).toBe(keyId);
});

test("discovery refuses insecure URLs, credentials, fragments, and redirects", async () => {
  const never = async () => {
    throw new Error("fetch should not run");
  };
  await expect(
    discoverVerificationKeyDocument("http://keys.example.test/keys", keyId, {
      fetch: never,
    }),
  ).rejects.toThrow(/requires HTTPS/u);
  await expect(
    discoverVerificationKeyDocument(
      "https://user:pass@keys.example.test/keys",
      keyId,
      { fetch: never },
    ),
  ).rejects.toThrow(/credentials/u);
  await expect(
    discoverVerificationKeyDocument(
      "https://keys.example.test/keys#kid",
      keyId,
      { fetch: never },
    ),
  ).rejects.toThrow(/fragment/u);
  await expect(
    discoverVerificationKeyDocument("https://keys.example.test/keys", keyId, {
      fetch: async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://other.example.test/keys" },
        }),
    }),
  ).rejects.toThrow(/redirects are not permitted/u);
});

test("HTTP is an explicit loopback-only development exception", async () => {
  await expect(
    discoverVerificationKeyDocument(
      "http://localhost:8787/v1/proof-verification-keys",
      keyId,
      { fetch: async () => jsonResponse({ keyset: vectors.keyset }) },
    ),
  ).rejects.toThrow(/requires HTTPS/u);
  await expect(
    discoverVerificationKeyDocument(
      "http://127.0.0.1:8787/v1/proof-verification-keys",
      keyId,
      {
        allow_http_loopback: true,
        fetch: async () => jsonResponse({ keyset: vectors.keyset }),
      },
    ),
  ).resolves.toBeDefined();
});

test("discovery enforces response bounds, media type, JSON shape, and requested kid", async () => {
  await expect(
    discoverVerificationKeyDocument("https://keys.example.test/keys", keyId, {
      max_response_bytes: 1_024,
      fetch: async () =>
        new Response("x".repeat(1_025), {
          headers: { "content-type": "application/json" },
        }),
    }),
  ).rejects.toThrow(/byte limit/u);
  await expect(
    discoverVerificationKeyDocument("https://keys.example.test/keys", keyId, {
      fetch: async () =>
        new Response("{}", { headers: { "content-type": "text/html" } }),
    }),
  ).rejects.toThrow(/unsupported content type/u);
  await expect(
    discoverVerificationKeyDocument("https://keys.example.test/keys", keyId, {
      fetch: async () =>
        new Response('{"key":', {
          headers: { "content-type": "application/json" },
        }),
    }),
  ).rejects.toThrow(/invalid JSON/u);
  const other = structuredClone(vectors.keyset);
  other.keys[0].key_id = "some-other-kid";
  await expect(
    discoverVerificationKeyDocument("https://keys.example.test/keys", keyId, {
      fetch: async () => jsonResponse({ keyset: other }),
    }),
  ).rejects.toThrow(/does not contain requested key ID/u);
});

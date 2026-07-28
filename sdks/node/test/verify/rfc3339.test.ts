/**
 * Ported verbatim from the standalone verifier's `test/rfc3339.test.mjs` (node:test).
 * Every vector and every assertion is the same; only the runner changed.
 */

import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  isRfc3339Timestamp,
  parseVerificationKey,
  rfc3339TimestampMilliseconds,
  rfc3339TimestampNanoseconds,
  verifyReceipt,
} from "../../src/verify/index.js";

const timestamps = JSON.parse(
  readFileSync(
    new URL("../fixtures/verify-vectors/rfc3339-vectors.json", import.meta.url),
    "utf8",
  ),
);
const receiptVectors = JSON.parse(
  readFileSync(
    new URL(
      "../fixtures/verify-vectors/ed25519-receipt-vectors.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const receipt = receiptVectors.signed_receipt;
const keyset = receiptVectors.keyset;

describe("RFC 3339 vectors", () => {
  for (const vector of timestamps.accepted) {
    test(`RFC 3339 acceptance vector: ${vector.id}`, () => {
      expect(isRfc3339Timestamp(vector.value)).toBe(true);
      expect(Number.isFinite(rfc3339TimestampMilliseconds(vector.value))).toBe(
        true,
      );
      expect(() =>
        parseVerificationKey({
          ...structuredClone(keyset.keys[0]),
          lifecycle: { status: "retired", status_changed_at: vector.value },
        }),
      ).not.toThrow();
    });
  }

  for (const vector of timestamps.rejected) {
    test(`RFC 3339 rejection vector: ${vector.id}`, () => {
      expect(isRfc3339Timestamp(vector.value)).toBe(false);
      expect(rfc3339TimestampMilliseconds(vector.value)).toBe(null);
      expect(() =>
        parseVerificationKey({
          ...structuredClone(keyset.keys[0]),
          lifecycle: { status: "retired", status_changed_at: vector.value },
        }),
      ).toThrow(/component-valid RFC 3339/u);
      expect(() =>
        verifyReceipt(receipt, keyset, { at: vector.value }),
      ).toThrow(/verification time is invalid/u);
    });
  }
});

test("freshness accepts a real leap day and rejects a normalized nonexistent day", () => {
  const leapDay = structuredClone(receipt);
  leapDay.expiry = {
    issued_at: "2024-02-29T00:00:00.000Z",
    recheck_at: "2024-03-01T00:00:00.000Z",
    expires_at: "2024-03-02T00:00:00.000Z",
  };
  expect(
    verifyReceipt(leapDay, keyset, { at: "2024-02-29T12:00:00.000Z" }).freshness
      .status,
  ).toBe("fresh");

  const nonexistentDay = structuredClone(receipt);
  nonexistentDay.expiry.issued_at = "2026-02-29T00:00:00.000Z";
  const result = verifyReceipt(nonexistentDay, keyset, {
    at: "2026-03-01T00:00:00.000Z",
  });
  expect(result.freshness.status).toBe("unknown");
  expect(result.freshness.reason).toMatch(/missing or malformed/u);
});

test("freshness preserves distinct RFC 3339 boundaries inside one millisecond", () => {
  const submillisecond = structuredClone(receipt);
  submillisecond.expiry = {
    issued_at: "2026-07-20T00:00:00.000000000Z",
    recheck_at: "2026-07-20T00:00:00.000000002Z",
    expires_at: "2026-07-20T00:00:00.000000003Z",
  };
  expect(rfc3339TimestampMilliseconds("2026-07-20T00:00:00.000000001Z")).toBe(
    rfc3339TimestampMilliseconds("2026-07-20T00:00:00.000000002Z"),
  );
  expect(
    rfc3339TimestampNanoseconds("2026-07-20T00:00:00.000000001Z"),
  ).not.toBe(rfc3339TimestampNanoseconds("2026-07-20T00:00:00.000000002Z"));
  for (const [at, expected] of [
    ["2026-07-20T00:00:00.000000001Z", "fresh"],
    ["2026-07-20T00:00:00.000000002Z", "recheck_due"],
    ["2026-07-20T00:00:00.000000003Z", "expired"],
  ] as const) {
    expect(verifyReceipt(submillisecond, keyset, { at }).freshness.status).toBe(
      expected,
    );
  }
});

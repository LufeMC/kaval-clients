/**
 * Ported verbatim from the standalone verifier's `test/canonicalization.test.mjs` (node:test).
 * Every vector and every assertion is the same; only the runner changed.
 */

import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  canonicalUnsignedReceiptJson,
  parseJsonStrict,
  stableCanonicalJson,
} from "../../src/verify/index.js";

const vectors = JSON.parse(
  readFileSync(
    new URL(
      "../fixtures/verify-vectors/canonicalization-vectors.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

describe("canonicalization vectors", () => {
  for (const vector of vectors.positive) {
    test(`canonicalization vector: ${vector.id}`, () => {
      const actual = vector.remove_top_level_signature
        ? canonicalUnsignedReceiptJson(vector.input)
        : stableCanonicalJson(vector.input);
      expect(actual).toBe(vector.expected_canonical_json);
      expect(Buffer.from(actual, "utf8").toString("hex")).toBe(
        vector.expected_utf8_hex,
      );
    });
  }

  for (const vector of vectors.rejection) {
    test(`canonicalization rejection vector: ${vector.id}`, () => {
      expect(() => parseJsonStrict(vector.json_text)).toThrow(
        new RegExp(vector.error_contains),
      );
    });
  }
});

test("canonicalization rejects non-JSON JavaScript values and cycles", () => {
  expect(() => stableCanonicalJson({ value: undefined })).toThrow(
    /does not permit undefined/u,
  );
  expect(() => stableCanonicalJson({ value: Number.NaN })).toThrow(
    /non-finite/u,
  );
  expect(() =>
    stableCanonicalJson({ value: Number.MAX_SAFE_INTEGER + 1 }),
  ).toThrow(/safe-integer range/u);
  expect(() => stableCanonicalJson(new Date())).toThrow(/plain JSON objects/u);
  const cyclic: Record<string, unknown> = {};
  cyclic["self"] = cyclic;
  expect(() => stableCanonicalJson(cyclic)).toThrow(/cyclic/u);
});

test("strict parser rejects decimal and exponent spellings that lose information", () => {
  expect(Number("9007199254740992")).toBe(Number("9007199254740993"));
  for (const text of [
    '{"value":9007199254740992}',
    '{"value":9007199254740993}',
    '{"value":9.007199254740993e15}',
    '{"value":0.10000000000000001}',
    '{"value":1.0000000000000001}',
    '{"value":1e-400}',
  ]) {
    expect(() => parseJsonStrict(text)).toThrow(
      /safe-integer range|loses information/u,
    );
  }
  expect({
    ...(parseJsonStrict('{"a":1.0,"b":1e0,"c":0.1,"d":1e-30}') as object),
  }).toEqual({
    a: 1,
    b: 1,
    c: 0.1,
    d: 1e-30,
  });
});

test("strict parser enforces depth and node bounds", () => {
  expect(() => parseJsonStrict("[[[[0]]]]", { max_depth: 2 })).toThrow(
    /depth limit/u,
  );
  expect(() => parseJsonStrict("[1,2,3]", { max_nodes: 2 })).toThrow(
    /node limit/u,
  );
});

/**
 * Ported verbatim from the standalone verifier's `test/verifier.test.mjs` (node:test).
 * Every vector and every assertion is the same; only the runner changed.
 */

import { createPrivateKey, sign as signBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import {
  KAVAL_CANONICALIZATION,
  canonicalUnsignedReceiptBytes,
  canonicalUnsignedReceiptJson,
  extractReceipt,
  verifyReceipt,
  verifyReceiptText,
} from "../../src/verify/index.js";

const vectors = JSON.parse(
  readFileSync(
    new URL(
      "../fixtures/verify-vectors/ed25519-receipt-vectors.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const receipt = vectors.signed_receipt;
const keyset = vectors.keyset;

function lifecycle(status: string, extra: Record<string, unknown> = {}) {
  const changed =
    status === "revoked" || status === "compromised"
      ? {
          status_changed_at: "2026-07-20T12:00:00.000Z",
          reason: `test ${status}`,
        }
      : {};
  const clone = structuredClone(keyset);
  clone.keys[0].lifecycle = { status, ...changed, ...extra };
  return clone;
}

test("published Ed25519 positive vector verifies exact canonical bytes", () => {
  expect(canonicalUnsignedReceiptJson(receipt)).toBe(
    vectors.expected.canonical_unsigned_json,
  );
  const result = verifyReceipt(receipt, keyset, {
    at: "2026-07-20T12:00:00.000Z",
  });
  expect(result.format.valid).toBe(true);
  expect(result.cryptographic.valid).toBe(true);
  expect(result.key.lifecycle_status).toBe("active");
  expect(result.key.trusted).toBe(true);
  expect(result.freshness.status).toBe("fresh");
  expect(result.accepted).toBe(true);
  expect(result.canonicalization.sha256).toBe(
    vectors.expected.canonical_unsigned_sha256,
  );
});

test("published Ed25519 negative vectors fail for the promised reason", () => {
  for (const vector of vectors.negative_cases) {
    const result = verifyReceipt(vector.receipt, keyset, {
      at: "2026-07-20T12:00:00.000Z",
    });
    if (vector.expected_format_valid === false) {
      expect(result.format.valid, vector.id).toBe(false);
    }
    if (vector.expected_cryptographic_valid === false) {
      expect(result.cryptographic.valid, vector.id).toBe(false);
    }
    expect(result.accepted, vector.id).toBe(false);
  }
});

test("tamper, wrong key, and unsupported canonicalization are independent failures", () => {
  const tampered = structuredClone(receipt);
  tampered.research_contract.held_belief = "Tampered after issuance.";
  expect(
    verifyReceipt(tampered, keyset, { at: "2026-07-20T12:00:00.000Z" })
      .cryptographic.valid,
  ).toBe(false);

  const wrongKeyset = structuredClone(keyset);
  wrongKeyset.keys[0].public_key.x =
    "PUAXw-hDiVqStwqnTRt-vJyYLM8uxJaMwM1V8Sr0Zgw";
  expect(
    verifyReceipt(receipt, wrongKeyset, { at: "2026-07-20T12:00:00.000Z" })
      .cryptographic.valid,
  ).toBe(false);

  const wrongCanonicalization = structuredClone(keyset);
  wrongCanonicalization.keys[0].canonicalization = "some-other-json-contract";
  const result = verifyReceipt(receipt, wrongCanonicalization, {
    at: "2026-07-20T12:00:00.000Z",
  });
  expect(result.cryptographic.valid).toBe(true);
  expect(result.key.trusted).toBe(false);
  expect(result.accepted).toBe(false);
});

test("rotation preserves retired-key history while revocation and compromise only remove trust", () => {
  for (const status of ["active", "retired"]) {
    const result = verifyReceipt(receipt, lifecycle(status), {
      at: "2026-07-20T12:00:00.000Z",
    });
    expect(result.cryptographic.valid, status).toBe(true);
    expect(result.key.trusted, status).toBe(true);
    expect(result.accepted, status).toBe(true);
  }
  for (const status of ["revoked", "compromised"]) {
    const result = verifyReceipt(receipt, lifecycle(status), {
      at: "2026-07-20T12:00:00.000Z",
    });
    expect(result.cryptographic.valid, status).toBe(true);
    expect(result.key.lifecycle_status, status).toBe(status);
    expect(result.key.trusted, status).toBe(false);
    expect(result.accepted, status).toBe(false);
  }
});

test("freshness changes without changing cryptographic validity", () => {
  const cases = [
    ["2026-07-19T23:59:59.999Z", "not_yet_issued"],
    ["2026-07-20T12:00:00.000Z", "fresh"],
    ["2026-07-21T00:00:00.000Z", "recheck_due"],
    ["2026-07-22T00:00:00.000Z", "expired"],
  ] as const;
  for (const [at, expected] of cases) {
    const result = verifyReceipt(receipt, keyset, { at });
    expect(result.cryptographic.valid).toBe(true);
    expect(result.accepted).toBe(true);
    expect(result.freshness.status).toBe(expected);
  }
});

test("unknown key IDs, malformed envelopes, and malformed keysets fail closed", () => {
  const unknown = structuredClone(receipt);
  unknown.signature.key_id = "not-published";
  expect(verifyReceipt(unknown, keyset).cryptographic.error).toMatch(
    /unknown verification key/u,
  );

  const extraSignatureField = structuredClone(receipt);
  extraSignatureField.signature.created_at = "2026-07-20T00:00:00.000Z";
  expect(verifyReceipt(extraSignatureField, keyset).format.valid).toBe(false);

  const unsigned = structuredClone(receipt);
  delete unsigned.signature;
  expect(verifyReceipt(unsigned, keyset).format.valid).toBe(false);

  const malformedKeyset = structuredClone(keyset);
  malformedKeyset.keys[0].public_key.d = vectors.test_private_key.d;
  const malformed = verifyReceipt(receipt, malformedKeyset);
  expect(malformed.cryptographic.valid).toBe(false);
  expect(malformed.key.reason).toMatch(/malformed/u);

  const duplicatePublicKey = structuredClone(keyset);
  duplicatePublicKey.keys.push({
    ...structuredClone(duplicatePublicKey.keys[0]),
    key_id: "same-key-different-id",
  });
  const duplicate = verifyReceipt(receipt, duplicatePublicKey);
  expect(duplicate.cryptographic.valid).toBe(false);
  expect(duplicate.key.reason).toMatch(/reuses one Ed25519 public key/u);
});

test("duplicate-key JSON is rejected before verification", () => {
  const duplicateReceipt =
    '{"proof_id":"first","proof_id":"second","signature":{"algorithm":"Ed25519","key_id":"vector-ed25519-001","signature":"nEhBjbwHB3wZGr4GE-rVb-mDBGBfK9BPOG-zxDNzORtVvHQGAIKFvoL4DONpnJa_cWiJwkXssDCt3kwUMy6QDg"}}';
  const result = verifyReceiptText(duplicateReceipt, JSON.stringify(keyset));
  expect(result.format.valid).toBe(false);
  expect(result.format.error).toMatch(/duplicate JSON object key/u);
});

test("colliding unsafe integer and rounded decimal receipt texts fail before verification", () => {
  const withProbe = (lexeme: string) =>
    JSON.stringify({ ...receipt, numeric_probe: "RAW_NUMBER" }).replace(
      '"RAW_NUMBER"',
      lexeme,
    );
  const collidingIntegers = ["9007199254740992", "9007199254740993"];
  expect(Number(collidingIntegers[0])).toBe(Number(collidingIntegers[1]));
  for (const lexeme of [
    ...collidingIntegers,
    "9.007199254740993e15",
    "0.10000000000000001",
    "1.0000000000000001",
  ]) {
    const result = verifyReceiptText(withProbe(lexeme), JSON.stringify(keyset));
    expect(result.format.valid, lexeme).toBe(false);
    expect(result.format.error, lexeme).toMatch(
      /safe-integer range|loses information/u,
    );
    expect(result.cryptographic.valid, lexeme).toBe(false);
    expect(result.accepted, lexeme).toBe(false);
  }
});

test("shared receipt wrappers unwrap exactly one packet and ambiguous wrappers fail", () => {
  expect(extractReceipt({ run: { packet: receipt } })).toEqual(receipt);
  expect(extractReceipt({ packet: receipt })).toEqual(receipt);
  expect(extractReceipt(receipt)).toEqual(receipt);
  expect(() =>
    extractReceipt({ packet: receipt, run: { packet: receipt } }),
  ).toThrow(/exactly one packet wrapper/u);
});

/**
 * A `/v1/check` receipt is the other document Kaval signs, and the one a customer is most likely to
 * be handed. It differs from a ProofPacket in exactly one respect the verifier can see: its
 * signature block also carries `signed_at`. Until this was accepted, a customer told to verify our
 * receipt with our own published verifier could not.
 *
 * `signed_at` is NOT covered by the signature — canonicalization strips the whole signature block —
 * so it is authenticated by being required to equal the signed `checked_at`. See the tampering test
 * below, which failed to reject before that binding existed.
 */
function checkReceiptFixture() {
  const unsigned = {
    receipt_version: "1",
    id: "6cbf0a67-1e5e-4a1a-9f52-6c9b6e2d2a10",
    tenant_id: "0f3e0f1d-1f2a-4b3c-8d4e-5f60718293a4",
    workspace_id: null,
    decision: "REVIEW",
    reason_codes: ["SOURCE_UPDATED_PENDING_REVIEW"],
    decision_rule_version: "check-decision/1",
    mode: "standard",
    checked_at: "2026-07-20T00:00:00.000Z",
    compilation_uncertain: false,
    facts: [
      {
        fingerprint: "fact:vector-001",
        text: "Aetna reimburses CPT 99213 at $92 per encounter under policy 123.",
        materiality: "high",
        state: "holds",
        checked_at: "2026-07-20T00:00:00.000Z",
        method: "state",
        temporal_state: "current",
        stale_pending: true,
        novel: false,
        freshness_failure: null,
        basis: [{ source_locator: "https://example.test/policy/123" }],
      },
    ],
    proof_packet_ids: [],
  };
  const privateKey = createPrivateKey({
    key: vectors.test_private_key,
    format: "jwk",
  });
  const signature = signBytes(
    null,
    canonicalUnsignedReceiptBytes(unsigned),
    privateKey,
  );
  return {
    ...unsigned,
    signature: {
      algorithm: "Ed25519",
      key_id: "vector-ed25519-001",
      signature: signature.toString("base64url"),
      signed_at: "2026-07-20T00:00:00.000Z",
    },
  };
}

test("a /v1/check receipt verifies through the published entry point", () => {
  const checkReceipt = checkReceiptFixture();
  const result = verifyReceipt(checkReceipt, keyset, {
    at: "2026-07-20T12:00:00.000Z",
  });
  expect(result.format.valid).toBe(true);
  expect(result.cryptographic.valid).toBe(true);
  expect(result.key.trusted).toBe(true);
  expect(result.accepted).toBe(true);
  // A check receipt carries no `expiry` block, so freshness is honestly unknown rather than a
  // fabricated pass — and it must not be allowed to gate acceptance of the signature envelope.
  expect(result.freshness.status).toBe("unknown");
});

test("a tampered /v1/check receipt fails while its format stays well formed", () => {
  const tampered = checkReceiptFixture();
  tampered.decision = "ALLOW";
  const result = verifyReceipt(tampered, keyset, {
    at: "2026-07-20T12:00:00.000Z",
  });
  expect(result.format.valid).toBe(true);
  expect(result.cryptographic.valid).toBe(false);
  expect(result.accepted).toBe(false);

  // Flipping a per-fact discriminator is the subtler attack: it would change the verdict an offline
  // auditor re-derives, so it has to break the signature exactly as rewriting the verdict does.
  const rewrittenFact = checkReceiptFixture();
  rewrittenFact.facts[0]!.stale_pending = false;
  expect(verifyReceipt(rewrittenFact, keyset).cryptographic.valid).toBe(false);
});

test("the signature block stays a closed allowlist, not merely a size check", () => {
  // `signed_at` is admitted; anything else is not, and dropping a required member is still fatal —
  // otherwise an appended field could shadow the algorithm or key a lax verifier reads.
  const unknownField = checkReceiptFixture() as Record<string, any>;
  unknownField["signature"].created_at = "2026-07-20T00:00:00.000Z";
  expect(verifyReceipt(unknownField, keyset).format.valid).toBe(false);

  const swapped = checkReceiptFixture() as Record<string, any>;
  delete swapped["signature"].key_id;
  expect(verifyReceipt(swapped, keyset).format.valid).toBe(false);

  const badSignedAt = checkReceiptFixture();
  badSignedAt.signature.signed_at = "the twentieth of July";
  const result = verifyReceipt(badSignedAt, keyset);
  expect(result.format.valid).toBe(false);
  expect(result.format.error).toMatch(/signed_at is not an RFC 3339 instant/u);
});

/**
 * THE FIELD THE SIGNATURE DOES NOT COVER.
 *
 * Canonicalization strips the whole `signature` member before hashing, so nothing inside the block
 * is in the signed bytes — including `signed_at`, which is the one field a holder reads to answer
 * "when was this attested?". Before `signed_at` was bound to `checked_at`, this exact mutation
 * returned `accepted: true` with `cryptographic.valid: true` and `key.trusted: true`, because the
 * bytes really were untouched.
 *
 * The binding works because `checked_at` IS signed: moving `signed_at` alone now contradicts it, and
 * moving both breaks the signature. The issuer has always set one value for both, so no receipt that
 * was ever legitimately issued is affected.
 */
test("a rewritten signed_at is rejected even though the signed bytes are untouched", () => {
  const genuine = checkReceiptFixture();
  const canonical = canonicalUnsignedReceiptBytes(genuine);

  const backdated = checkReceiptFixture();
  backdated.signature.signed_at = "2019-01-01T00:00:00.000Z";

  // The mutation is entirely outside the signed bytes — this is what made it invisible.
  expect(canonicalUnsignedReceiptBytes(backdated)).toEqual(canonical);

  const result = verifyReceipt(backdated, keyset, {
    at: "2026-07-20T12:00:00.000Z",
  });
  expect(result.accepted).toBe(false);
  expect(result.format.valid).toBe(false);
  expect(result.format.error).toMatch(
    /signed_at does not match the signed checked_at/u,
  );

  // The ProofPacket vector has neither field, and must keep verifying untouched by this rule.
  expect(Object.hasOwn(receipt.signature, "signed_at")).toBe(false);
  expect(verifyReceipt(receipt, keyset).accepted).toBe(true);
});

test("key documents must declare the frozen Kaval canonicalization", () => {
  expect(keyset.canonicalization).toBe(KAVAL_CANONICALIZATION);
  const missing = structuredClone(keyset);
  delete missing.canonicalization;
  delete missing.keys[0].canonicalization;
  const result = verifyReceipt(receipt, missing);
  expect(result.cryptographic.valid).toBe(true);
  expect(result.key.trusted).toBe(false);
});

/**
 * The verifier and the SDK's receipt types have to agree about what a basis entry contains.
 *
 * `version_sha256_of`, `parser_name` and `parser_version` were added to the basis so a holder can
 * tell WHICH artifact `version_sha256` covers — a PDF's extracted canonical text and its raw bytes
 * have two different, both-legitimate digests, and an unlabelled digest is decorative. That only
 * works if the labels are inside the signed bytes: a label an attacker can flip from
 * `canonical_text` to `raw_bytes` after issuance sends the auditor to re-hash the wrong artifact and
 * conclude the receipt is bad (or, worse, hands them a digest that "matches" the wrong thing).
 *
 * The verifier deliberately has no schema of its own — it seals whatever the issuer signed — so the
 * assertion that matters is that these three fields are covered by the signature and that moving any
 * one of them breaks it. `CheckReceiptBasis` is imported from the SDK's own types, so a field
 * renamed or dropped there stops compiling here.
 */

import { createPrivateKey, sign as signBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import type { CheckReceiptBasis } from "../../src/index.js";
import {
  canonicalUnsignedReceiptBytes,
  canonicalUnsignedReceiptJson,
  verifyReceipt,
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
const keyset = vectors.keyset;

/** Exactly the shape the SDK documents, with every repaired field populated. */
const BASIS: CheckReceiptBasis = {
  source_locator: "https://example.test/policy/123.pdf",
  version_sha256:
    "0ac0e1cb3d0a2c8fb7d9f0d3f4b4a9a06d4dcb5b39a1a6a35a3f9c9c4be0b111",
  version_sha256_of: "canonical_text",
  parser_name: "pdf-to-markdown",
  parser_version: "3.1.0",
  fetched_at: "2026-07-20T00:00:00.000Z",
  publication_time: "2026-07-19T00:00:00.000Z",
};

function signedCheckReceipt(basis: CheckReceiptBasis) {
  const unsigned = {
    receipt_version: "1",
    id: "0d0a1c6b-2f47-4f0b-9d63-6d1f3d5a7c22",
    tenant_id: "0f3e0f1d-1f2a-4b3c-8d4e-5f60718293a4",
    workspace_id: null,
    decision: "ALLOW",
    reason_codes: [],
    decision_rule_version: "check-decision/1",
    mode: "standard",
    checked_at: "2026-07-20T00:00:00.000Z",
    compilation_uncertain: false,
    facts: [
      {
        fingerprint: "fact:basis-001",
        text: "Aetna reimburses CPT 99213 at $92 per encounter under policy 123.",
        materiality: "high",
        state: "holds",
        checked_at: "2026-07-20T00:00:00.000Z",
        method: "state",
        temporal_state: "current",
        stale_pending: false,
        novel: false,
        freshness_failure: null,
        basis: [basis],
      },
    ],
    proof_packet_ids: [],
  };
  const privateKey = createPrivateKey({
    key: vectors.test_private_key,
    format: "jwk",
  });
  return {
    ...unsigned,
    signature: {
      algorithm: "Ed25519",
      key_id: "vector-ed25519-001",
      signature: signBytes(
        null,
        canonicalUnsignedReceiptBytes(unsigned),
        privateKey,
      ).toString("base64url"),
      signed_at: "2026-07-20T00:00:00.000Z",
    },
  };
}

test("a receipt whose basis carries the repaired fields verifies, and they are in the signed bytes", () => {
  const receipt = signedCheckReceipt(BASIS);
  const result = verifyReceipt(receipt, keyset, {
    at: "2026-07-20T12:00:00.000Z",
  });
  expect(result.format.valid).toBe(true);
  expect(result.cryptographic.valid).toBe(true);
  expect(result.key.trusted).toBe(true);
  expect(result.accepted).toBe(true);

  // Canonicalization sorts keys and drops nothing: the three fields are inside the hashed bytes.
  const canonical = canonicalUnsignedReceiptJson(receipt);
  expect(canonical).toContain('"version_sha256_of":"canonical_text"');
  expect(canonical).toContain('"parser_name":"pdf-to-markdown"');
  expect(canonical).toContain('"parser_version":"3.1.0"');
  expect(canonical.indexOf('"parser_name"')).toBeLessThan(
    canonical.indexOf('"parser_version"'),
  );
  expect(canonical).not.toContain('"signature"');
});

test("rewriting any one of the three repaired basis fields breaks the signature", () => {
  const genuine = signedCheckReceipt(BASIS);
  const mutations: Array<[string, CheckReceiptBasis]> = [
    // The label swap is the whole reason `version_sha256_of` exists: same digest, wrong artifact.
    ["version_sha256_of", { ...BASIS, version_sha256_of: "raw_bytes" }],
    ["parser_name", { ...BASIS, parser_name: "some-other-extractor" }],
    ["parser_version", { ...BASIS, parser_version: "2.0.0" }],
  ];
  for (const [field, mutated] of mutations) {
    const tampered = { ...genuine, facts: structuredClone(genuine.facts) };
    tampered.facts[0]!.basis = [mutated];
    const result = verifyReceipt(tampered, keyset, {
      at: "2026-07-20T12:00:00.000Z",
    });
    expect(result.format.valid, field).toBe(true);
    expect(result.cryptographic.valid, field).toBe(false);
    expect(result.accepted, field).toBe(false);
  }
});

test("dropping a repaired basis field is a mutation too, not a tolerated omission", () => {
  const genuine = signedCheckReceipt(BASIS);
  const { version_sha256_of: _dropped, ...withoutLabel } = BASIS;
  const tampered = { ...genuine, facts: structuredClone(genuine.facts) };
  tampered.facts[0]!.basis = [withoutLabel];
  expect(
    verifyReceipt(tampered, keyset, { at: "2026-07-20T12:00:00.000Z" })
      .cryptographic.valid,
  ).toBe(false);

  // A basis that never carried them still verifies — the fields are optional in the contract, and
  // the verifier seals what the issuer signed rather than imposing a schema of its own.
  const minimal = signedCheckReceipt({
    source_locator: "https://example.test/policy/123",
  });
  expect(
    verifyReceipt(minimal, keyset, { at: "2026-07-20T12:00:00.000Z" }).accepted,
  ).toBe(true);
});

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  CHECK_ACTION_CLASSIFICATION_STATUSES,
  CHECK_ALLOW_GATE_EVALUATION_STATUSES,
  CHECK_ALLOW_GATE_MODES,
  CHECK_ALLOW_GATE_REASON_CODES,
  CHECK_ALLOW_GATE_STATUSES,
  CHECK_DECISION_RULE_V2_VERSION,
  CHECK_DECISION_RULE_LATEST_VERSION,
  CHECK_DECISION_RULE_VERSION,
  CHECK_DECISION_RULE_VERSIONS,
  CHECK_DECISION_V2_REASON_CODES,
  CHECK_RECEIPT_V2_VERSION,
  ReceiptNotSelfDerivableError,
  deriveCheckDecision,
  deriveCheckDecisionV2,
  parseCheckReceiptV2DecisionFields,
  verifyReceipt,
  type CheckAllowGateReasonCode,
  type CheckDecisionV2ReasonCode,
  type CheckVerdict,
} from "../../src/verify/index.js";

interface ExpectedDecision {
  verdict: CheckVerdict;
  reason_codes: CheckDecisionV2ReasonCode[];
  candidate_decision: CheckVerdict;
  candidate_reason_codes: string[];
  gate: { status: string; reason_codes: CheckAllowGateReasonCode[] };
}

interface DeriveVector {
  id: string;
  patch: Record<string, unknown>;
  expected: ExpectedDecision;
}

interface RefuseVector {
  id: string;
  patch: Record<string, unknown>;
  message_contains: string;
}

interface SignedVector {
  id: string;
  patch: Record<string, unknown>;
  signature_base64url: string;
  expected_verdict: CheckVerdict;
}

const vectors = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL(
        "../fixtures/verify-vectors/check-decision-v2-vectors.json",
        import.meta.url,
      ),
    ),
    "utf8",
  ),
) as {
  receipt_version: string;
  decision_rule_version: string;
  base_receipt: Record<string, unknown>;
  signed_receipts: SignedVector[];
  derive: DeriveVector[];
  refuse: RefuseVector[];
};

const ed25519Vectors = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL(
        "../fixtures/verify-vectors/ed25519-receipt-vectors.json",
        import.meta.url,
      ),
    ),
    "utf8",
  ),
) as { keyset: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Apply the vector format's recursive patch. Arrays and null values replace the base value. */
function patched(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const result = structuredClone(base);
  for (const [key, value] of Object.entries(patch)) {
    const current = result[key];
    result[key] =
      isRecord(value) && isRecord(current)
        ? patched(current, value)
        : structuredClone(value);
  }
  return result;
}

function receiptFor(
  vector: DeriveVector | RefuseVector | SignedVector,
): Record<string, unknown> {
  return patched(vectors.base_receipt, vector.patch);
}

describe("check-decision/2.0.0 receipt vectors", () => {
  test("the versions and schema enums are frozen", () => {
    expect(CHECK_DECISION_RULE_VERSION).toBe("check-decision/1.1.0");
    expect(CHECK_DECISION_RULE_V2_VERSION).toBe("check-decision/2.0.0");
    expect(CHECK_DECISION_RULE_LATEST_VERSION).toBe(
      CHECK_DECISION_RULE_V2_VERSION,
    );
    expect(CHECK_RECEIPT_V2_VERSION).toBe("check-receipt/2.0.0");
    expect(CHECK_DECISION_RULE_VERSIONS).toContain(
      CHECK_DECISION_RULE_V2_VERSION,
    );
    expect(vectors.decision_rule_version).toBe(CHECK_DECISION_RULE_V2_VERSION);
    expect(vectors.receipt_version).toBe(CHECK_RECEIPT_V2_VERSION);
    expect(CHECK_ALLOW_GATE_STATUSES).toEqual([
      "not_applicable",
      "passed",
      "downgraded",
    ]);
    expect(CHECK_ALLOW_GATE_MODES).toEqual(["production", "demo"]);
    expect(CHECK_ALLOW_GATE_EVALUATION_STATUSES).toEqual([
      "available",
      "unavailable",
    ]);
    expect(CHECK_ACTION_CLASSIFICATION_STATUSES).toEqual([
      "classified",
      "unclassified",
    ]);
    expect(CHECK_ALLOW_GATE_REASON_CODES).toEqual([
      "ALLOW_ACTION_UNCLASSIFIED",
      "ALLOW_POLICY_UNBOUND",
      "ALLOW_CALIBRATION_UNBOUND",
      "ALLOW_CALIBRATION_INSUFFICIENT",
      "ALLOW_CALIBRATION_EXPIRED",
      "ALLOW_GATE_UNAVAILABLE",
    ]);
    for (const code of CHECK_ALLOW_GATE_REASON_CODES) {
      expect(CHECK_DECISION_V2_REASON_CODES).toContain(code);
    }
  });

  test("every positive vector derives the frozen candidate, gate, and final decision", () => {
    for (const vector of vectors.derive) {
      const receipt = receiptFor(vector);
      const parsed = parseCheckReceiptV2DecisionFields(receipt);
      expect(parsed.receipt_version, vector.id).toBe(CHECK_RECEIPT_V2_VERSION);
      expect(parsed.decision_rule_version, vector.id).toBe(
        CHECK_DECISION_RULE_V2_VERSION,
      );
      const expected = {
        ...vector.expected,
        decision_rule_version: CHECK_DECISION_RULE_V2_VERSION,
      };
      expect(deriveCheckDecisionV2(receipt), vector.id).toEqual(expected);
      expect(deriveCheckDecision(receipt), `${vector.id}: dispatch`).toEqual(
        expected,
      );
    }
  });

  test("every negative vector fails closed for its recorded reason", () => {
    for (const vector of vectors.refuse) {
      let thrown: unknown;
      try {
        deriveCheckDecision(receiptFor(vector));
      } catch (error) {
        thrown = error;
      }
      expect(thrown, vector.id).toBeInstanceOf(ReceiptNotSelfDerivableError);
      expect((thrown as Error).message, vector.id).toContain(
        vector.message_contains,
      );
    }
  });

  test("fixed Ed25519 rule-2 receipts verify and re-derive entirely offline", () => {
    for (const vector of vectors.signed_receipts) {
      const unsigned = receiptFor(vector);
      const receipt = {
        ...unsigned,
        signature: {
          algorithm: "Ed25519",
          key_id: "vector-ed25519-001",
          signature: vector.signature_base64url,
          signed_at: String(unsigned["checked_at"]),
        },
      };
      const result = verifyReceipt(receipt, ed25519Vectors.keyset, {
        derive_verdict: true,
      });
      expect(result.cryptographic.valid, vector.id).toBe(true);
      expect(result.decision?.matches, vector.id).toBe(true);
      expect(result.decision?.derived?.verdict, vector.id).toBe(
        vector.expected_verdict,
      );
      expect(result.accepted, vector.id).toBe(true);
    }
  });

  test("a signed rule-2 gate field cannot change without invalidating the receipt", () => {
    const vector = vectors.signed_receipts[0];
    expect(vector).toBeDefined();
    if (vector === undefined) return;
    const unsigned = receiptFor(vector);
    const gate = unsigned["gate"];
    expect(isRecord(gate)).toBe(true);
    if (!isRecord(gate)) return;
    const receipt = {
      ...unsigned,
      gate: {
        ...gate,
        status: "downgraded",
        reason_codes: ["ALLOW_POLICY_UNBOUND"],
      },
      signature: {
        algorithm: "Ed25519",
        key_id: "vector-ed25519-001",
        signature: vector.signature_base64url,
        signed_at: String(unsigned["checked_at"]),
      },
    };
    const result = verifyReceipt(receipt, ed25519Vectors.keyset, {
      derive_verdict: true,
    });
    expect(result.cryptographic.valid).toBe(false);
    expect(result.decision?.matches).toBe(false);
    expect(result.accepted).toBe(false);
  });

  test("the vector set covers each verdict and every ALLOW gate reason", () => {
    const results = vectors.derive.map((vector) => vector.expected);
    expect(
      [...new Set(results.map((result) => result.verdict))].sort(),
    ).toEqual(["ALLOW", "BLOCK", "REVIEW"]);
    expect(
      [
        ...new Set(results.flatMap((result) => result.gate.reason_codes)),
      ].sort(),
    ).toEqual([...CHECK_ALLOW_GATE_REASON_CODES].sort());
    expect(vectors.derive.length).toBeGreaterThanOrEqual(12);
    expect(vectors.refuse.length).toBeGreaterThanOrEqual(10);
  });
});

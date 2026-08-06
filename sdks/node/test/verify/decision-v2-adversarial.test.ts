import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { verifyReceipt } from "../../src/verify/index.js";

const vectors = JSON.parse(
  readFileSync(
    new URL(
      "../fixtures/verify-vectors/check-decision-v2-vectors.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  base_receipt: Record<string, unknown>;
  signed_receipts: Array<{ signature_base64url: string }>;
};

const signatures = JSON.parse(
  readFileSync(
    new URL(
      "../fixtures/verify-vectors/ed25519-receipt-vectors.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as { keyset: unknown };

function signedAllowReceipt(): Record<string, unknown> {
  return {
    ...structuredClone(vectors.base_receipt),
    signature: {
      algorithm: "Ed25519",
      key_id: "vector-ed25519-001",
      signature: vectors.signed_receipts[0]!.signature_base64url,
      signed_at: vectors.base_receipt.checked_at,
    },
  };
}

function setPath(
  document: Record<string, unknown>,
  path: Array<string | number>,
  value: unknown,
): void {
  let target: unknown = document;
  for (const part of path.slice(0, -1)) {
    target = (target as Record<string | number, unknown>)[part];
  }
  (target as Record<string | number, unknown>)[path.at(-1)!] = value;
}

describe("check-decision/2.0.0 adversarial verification", () => {
  it("rejects tampering in every signed decision and ALLOW-gate field", () => {
    const mutations: Array<[string, Array<string | number>, unknown]> = [
      ["receipt version", ["receipt_version"], "check-receipt/1.0.0"],
      ["decision rule", ["decision_rule_version"], "check-decision/1.1.0"],
      ["checked time", ["checked_at"], "2026-08-05T12:00:00.001Z"],
      ["compilation state", ["compilation_uncertain"], true],
      ["fact state", ["facts", 0, "state"], "changed"],
      ["candidate decision", ["candidate_decision"], "REVIEW"],
      ["final decision", ["decision"], "REVIEW"],
      ["reason codes", ["reason_codes"], ["ALLOW_POLICY_UNBOUND"]],
      [
        "classification status",
        ["action_classification", "status"],
        "unclassified",
      ],
      [
        "action class",
        ["action_classification", "action_class"],
        "claims.changed",
      ],
      [
        "classifier version",
        ["action_classification", "classifier_version"],
        "changed/1",
      ],
      ["policy id", ["policy_binding", "id"], "policy-changed"],
      ["policy version", ["policy_binding", "version"], "2026-09"],
      [
        "policy action class",
        ["policy_binding", "action_class"],
        "claims.changed",
      ],
      ["policy sample minimum", ["policy_binding", "minimum_sample_size"], 251],
      [
        "policy false-allow maximum",
        ["policy_binding", "maximum_false_allow_upper_bound_bps"],
        49,
      ],
      [
        "policy valid-from",
        ["policy_binding", "valid_from"],
        "2026-08-06T00:00:00.000Z",
      ],
      [
        "policy valid-until",
        ["policy_binding", "valid_until"],
        "2026-08-05T12:00:00.000Z",
      ],
      ["policy mode", ["policy_binding", "demo_only"], true],
      ["calibration id", ["calibration_binding", "id"], "calibration-changed"],
      [
        "calibration policy id",
        ["calibration_binding", "policy_id"],
        "policy-changed",
      ],
      [
        "calibration policy version",
        ["calibration_binding", "policy_version"],
        "2026-09",
      ],
      [
        "calibration action",
        ["calibration_binding", "action_class"],
        "claims.changed",
      ],
      ["calibration sample", ["calibration_binding", "sample_size"], 99],
      [
        "calibration false-allow",
        ["calibration_binding", "false_allow_upper_bound_bps"],
        101,
      ],
      [
        "calibration evaluated time",
        ["calibration_binding", "evaluated_at"],
        "2026-08-05T12:00:00.001Z",
      ],
      [
        "calibration expiry",
        ["calibration_binding", "expires_at"],
        "2026-08-05T12:00:00.000Z",
      ],
      ["calibration mode", ["calibration_binding", "demo_only"], true],
      ["gate mode", ["gate", "mode"], "demo"],
      ["gate availability", ["gate", "evaluation_status"], "unavailable"],
      ["gate status", ["gate", "status"], "downgraded"],
      ["gate reasons", ["gate", "reason_codes"], ["ALLOW_GATE_UNAVAILABLE"]],
    ];

    for (const [name, path, value] of mutations) {
      const receipt = signedAllowReceipt();
      setPath(receipt, path, value);
      const result = verifyReceipt(receipt, signatures.keyset, {
        derive_verdict: true,
      });
      expect(result.cryptographic.valid, name).toBe(false);
      expect(result.accepted, name).toBe(false);
    }
  });

  it("rejects altered signature metadata and shadow fields", () => {
    for (const [field, value] of [
      ["algorithm", "none"],
      ["key_id", "vector-ed25519-999"],
      [
        "signature",
        `${vectors.signed_receipts[0]!.signature_base64url.slice(0, -1)}A`,
      ],
      ["signed_at", "2026-08-05T12:00:00.001Z"],
    ] as const) {
      const receipt = signedAllowReceipt();
      (receipt.signature as Record<string, unknown>)[field] = value;
      expect(
        verifyReceipt(receipt, signatures.keyset, { derive_verdict: true })
          .accepted,
        field,
      ).toBe(false);
    }

    const receipt = signedAllowReceipt();
    (receipt.signature as Record<string, unknown>).verdict = "ALLOW";
    expect(verifyReceipt(receipt, signatures.keyset).accepted).toBe(false);
  });
});

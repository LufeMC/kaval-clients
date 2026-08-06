import type { DerivedCheckDecision } from "./decision.js";

export const KAVAL_CANONICALIZATION = "kaval-stable-json-v1" as const;

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue =
  JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type KeyLifecycleStatus =
  "active" | "retired" | "revoked" | "compromised" | "unknown";

export interface KeyLifecycle {
  status: Exclude<KeyLifecycleStatus, "unknown">;
  status_changed_at?: string;
  reason?: string;
}

export interface VerificationKey {
  contract_version: "1";
  key_id: string;
  algorithm: "Ed25519";
  use: "proof_verification";
  canonicalization?: string;
  public_key: {
    format: "jwk";
    kty: "OKP";
    crv: "Ed25519";
    x: string;
  };
  lifecycle?: KeyLifecycle;
}

export type FreshnessStatus =
  "fresh" | "recheck_due" | "expired" | "not_yet_issued" | "unknown";

/**
 * What a verification result actually covers, stated in the result itself.
 *
 * `signature_envelope` — the historical and still the DEFAULT answer: the Ed25519 signature over the
 * canonical unsigned bytes, key trust, and timing. It deliberately says nothing about the verdict.
 *
 * `signature_envelope+decision_table` — the caller passed `derive_verdict: true`, so the result
 * additionally re-derives the receipt's verdict from the receipt's own facts using the published
 * `check-decision` table (see `decision.ts`) and compares it with the verdict the receipt states.
 *
 * Widening this union is additive by construction: a caller that never opts in never observes the
 * second value, so `scope === "signature_envelope"` keeps meaning exactly what it always meant.
 */
export type VerificationScope =
  "signature_envelope" | "signature_envelope+decision_table";

/**
 * The verdict half of a verification, present only when `derive_verdict: true` was requested.
 *
 * `derived` is computed from `facts[]` and `compilation_uncertain` ALONE. The receipt's own
 * `decision` / `reason_codes` are reported as `stated` and are never an input — reading the answer
 * off the answer would make the comparison vacuous. `matches` is the comparison, and it is the only
 * field that may move `accepted`.
 */
export interface VerificationDecision {
  /** The latest decision-table version this verifier executes. */
  supported_rule_version: string;
  /** The decision-table version the receipt names, when it names one. */
  receipt_rule_version?: string;
  stated?: {
    verdict?: string;
    reason_codes?: string[];
  };
  derived?: DerivedCheckDecision;
  /** True only when a verdict AND its reason-code set were re-derived and both agree. */
  matches: boolean;
  error?: string;
}

export interface VerificationResult {
  contract_version: "1";
  scope: VerificationScope;
  accepted: boolean;
  format: {
    valid: boolean;
    error?: string;
  };
  receipt: {
    proof_id?: string;
    algorithm?: string;
    key_id?: string;
  };
  canonicalization: {
    algorithm: typeof KAVAL_CANONICALIZATION;
    valid: boolean;
    byte_length?: number;
    sha256?: string;
    error?: string;
  };
  cryptographic: {
    valid: boolean;
    error?: string;
  };
  key: {
    found: boolean;
    key_id?: string;
    lifecycle_status: KeyLifecycleStatus;
    canonicalization?: string;
    trusted: boolean;
    reason: string;
    status_changed_at?: string;
  };
  freshness: {
    status: FreshnessStatus;
    evaluated_at: string;
    issued_at?: string;
    recheck_at?: string;
    expires_at?: string;
    reason?: string;
  };
  /** Present only when `derive_verdict: true` was requested. Additive; see `VerificationScope`. */
  decision?: VerificationDecision;
}

export interface VerifyOptions {
  at?: Date | number | string;
  /**
   * Also re-derive the receipt's verdict from its own facts and require it to match.
   *
   * OFF BY DEFAULT, and that default is a compatibility guarantee, not timidity: turning it on
   * changes `scope`, adds a `decision` block, and can turn a signature-valid result into
   * `accepted: false`. Every caller written before this option existed keeps the exact result shape
   * and the exact acceptance semantics it was written against.
   *
   * Only `POST /v1/check` receipts carry a fact list. A ProofPacket has none, so asking for
   * re-derivation on one fails closed rather than pretending the question was answered.
   */
  derive_verdict?: boolean;
}

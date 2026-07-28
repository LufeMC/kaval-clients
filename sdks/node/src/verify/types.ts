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

export interface VerificationResult {
  contract_version: "1";
  scope: "signature_envelope";
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
}

export interface VerifyOptions {
  at?: Date | number | string;
}

import type { KeyLifecycle, VerificationKey } from "./types.js";
import { isRfc3339Timestamp } from "./rfc3339.js";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function canonicalBase64Url(
  value: unknown,
  length: number,
  label: string,
): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new Error(`${label} must be unpadded base64url`);
  }
  const decoded = Buffer.from(value, "base64url");
  if (
    decoded.byteLength !== length ||
    decoded.toString("base64url") !== value
  ) {
    throw new Error(
      `${label} must be canonical base64url encoding exactly ${length} bytes`,
    );
  }
  return value;
}

function isoTimestamp(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (!isRfc3339Timestamp(value)) {
    throw new Error(`${label} must be a component-valid RFC 3339 timestamp`);
  }
  return value;
}

function parseLifecycle(value: unknown): KeyLifecycle | undefined {
  if (value === undefined) return undefined;
  const input = record(value);
  if (!input) throw new Error("key lifecycle must be an object");
  const allowed = new Set(["status", "status_changed_at", "reason"]);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw new Error("key lifecycle contains an unknown field");
  }
  const statuses = new Set(["active", "retired", "revoked", "compromised"]);
  if (typeof input["status"] !== "string" || !statuses.has(input["status"])) {
    throw new Error("key lifecycle status is invalid");
  }
  const status = input["status"] as KeyLifecycle["status"];
  const statusChangedAt = isoTimestamp(
    input["status_changed_at"],
    "key lifecycle status_changed_at",
  );
  const reason = input["reason"];
  if (
    reason !== undefined &&
    (typeof reason !== "string" || !reason.trim() || reason.length > 1_000)
  ) {
    throw new Error(
      "key lifecycle reason must be a non-empty string at most 1000 characters",
    );
  }
  if (
    (status === "revoked" || status === "compromised") &&
    (statusChangedAt === undefined || typeof reason !== "string")
  ) {
    throw new Error(`${status} keys require status_changed_at and reason`);
  }
  return {
    status,
    ...(statusChangedAt === undefined
      ? {}
      : { status_changed_at: statusChangedAt }),
    ...(typeof reason === "string" ? { reason } : {}),
  };
}

export function parseVerificationKey(
  value: unknown,
  inheritedCanonicalization?: string,
): VerificationKey {
  const input = record(value);
  if (!input) throw new Error("verification key must be an object");
  if (input["contract_version"] !== "1") {
    throw new Error("verification key contract_version must be '1'");
  }
  const keyId = input["key_id"];
  if (typeof keyId !== "string" || !keyId.trim() || keyId.length > 128) {
    throw new Error("verification key key_id must be 1 to 128 characters");
  }
  if (
    input["algorithm"] !== "Ed25519" ||
    input["use"] !== "proof_verification"
  ) {
    throw new Error(
      "verification key algorithm/use is not Ed25519 proof verification",
    );
  }
  const publicKey = record(input["public_key"]);
  if (
    !publicKey ||
    publicKey["format"] !== "jwk" ||
    publicKey["kty"] !== "OKP" ||
    publicKey["crv"] !== "Ed25519" ||
    Object.hasOwn(publicKey, "d")
  ) {
    throw new Error("verification key must contain a public Ed25519 OKP JWK");
  }
  const x = canonicalBase64Url(publicKey["x"], 32, "verification key x");
  const canonicalization =
    input["canonicalization"] ?? inheritedCanonicalization;
  if (canonicalization !== undefined && typeof canonicalization !== "string") {
    throw new Error("verification key canonicalization must be a string");
  }
  return {
    contract_version: "1",
    key_id: keyId,
    algorithm: "Ed25519",
    use: "proof_verification",
    ...(typeof canonicalization === "string" ? { canonicalization } : {}),
    public_key: {
      format: "jwk",
      kty: "OKP",
      crv: "Ed25519",
      x,
    },
    ...(input["lifecycle"] === undefined
      ? {}
      : { lifecycle: parseLifecycle(input["lifecycle"])! }),
  };
}

function entriesFromDocument(document: unknown): {
  entries: unknown[];
  inheritedCanonicalization?: string;
} {
  const input = record(document);
  if (!input) throw new Error("key document must be an object");
  if (Object.hasOwn(input, "key")) return { entries: [input["key"]] };
  const keysetWrapper = Object.hasOwn(input, "keyset")
    ? record(input["keyset"])
    : input;
  if (!keysetWrapper || !Array.isArray(keysetWrapper["keys"])) {
    return { entries: [input] };
  }
  const canonicalization = keysetWrapper["canonicalization"];
  if (canonicalization !== undefined && typeof canonicalization !== "string") {
    throw new Error("keyset canonicalization must be a string");
  }
  return {
    entries: keysetWrapper["keys"],
    ...(typeof canonicalization === "string"
      ? { inheritedCanonicalization: canonicalization }
      : {}),
  };
}

/** Resolve one immutable key ID from a per-key document or a versioned keyset. */
export function verificationKeyFromDocument(
  document: unknown,
  keyId: string,
): VerificationKey | null {
  const { entries, inheritedCanonicalization } = entriesFromDocument(document);
  let match: VerificationKey | null = null;
  const keyIdsByPublicKey = new Map<string, string>();
  for (const entry of entries) {
    const parsed = parseVerificationKey(entry, inheritedCanonicalization);
    const previousKeyId = keyIdsByPublicKey.get(parsed.public_key.x);
    if (previousKeyId !== undefined && previousKeyId !== parsed.key_id) {
      throw new Error(
        `key document reuses one Ed25519 public key under ${previousKeyId} and ${parsed.key_id}`,
      );
    }
    keyIdsByPublicKey.set(parsed.public_key.x, parsed.key_id);
    if (parsed.key_id !== keyId) continue;
    if (match)
      throw new Error(`key document contains duplicate key_id ${keyId}`);
    match = parsed;
  }
  return match;
}

export function decodeCanonicalBase64Url(
  value: unknown,
  length: number,
  label: string,
): Buffer {
  return Buffer.from(canonicalBase64Url(value, length, label), "base64url");
}

import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from "node:crypto";
import {
  canonicalUnsignedReceiptBytes,
  parseJsonStrict,
} from "./canonicalize.js";
import {
  CHECK_DECISION_RULE_VERSION,
  CHECK_DECISION_RULE_VERSIONS,
  ReceiptNotSelfDerivableError,
  deriveCheckDecision,
} from "./decision.js";
import {
  decodeCanonicalBase64Url,
  verificationKeyFromDocument,
} from "./key-document.js";
import { parseRfc3339Instant } from "./rfc3339.js";
import {
  KAVAL_CANONICALIZATION,
  type FreshnessStatus,
  type VerificationDecision,
  type VerificationResult,
  type VerificationScope,
  type VerifyOptions,
} from "./types.js";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Accept either a bare ProofPacket or Kaval's public shared-receipt response (`run.packet`).
 * Ambiguous wrappers fail closed instead of guessing which signed object the caller intended.
 */
export function extractReceipt(document: unknown): unknown {
  const input = record(document);
  if (!input) throw new Error("receipt document must be a JSON object");
  if (Object.hasOwn(input, "signature")) return input;
  const directPacket = record(input["packet"]);
  const runPacket = record(record(input["run"])?.["packet"]);
  const candidates = [directPacket, runPacket].filter(
    (candidate): candidate is Record<string, unknown> => candidate !== null,
  );
  if (candidates.length !== 1) {
    throw new Error(
      "receipt document must contain one bare receipt or exactly one packet wrapper",
    );
  }
  return candidates[0];
}

/**
 * The signature block Kaval issues, in both shapes a holder can legitimately be handed.
 *
 * A `ProofPacket` seals `{algorithm, key_id, signature}`. A `/v1/check` receipt adds `signed_at`.
 *
 * `signed_at` is NOT in the signed bytes — the canonicalizer strips the whole `signature` key, so
 * nothing inside the block can be. It is authenticated indirectly instead, by being required to
 * equal the receipt's `checked_at`, which is signed. That check is below; without it the field was
 * freely rewritable on an otherwise-valid receipt.
 *
 * This is an ALLOWLIST, not a relaxation — the block is still closed, so an unrecognised member (the
 * classic downgrade vector: an attacker appending an `algorithm`-shadowing or `key_id`-shadowing
 * field a lax verifier might read) is still rejected.
 */
const REQUIRED_SIGNATURE_FIELDS = ["algorithm", "key_id", "signature"] as const;
const OPTIONAL_SIGNATURE_FIELDS = ["signed_at"] as const;

function signatureFieldSetIsValid(signature: Record<string, unknown>): boolean {
  if (
    REQUIRED_SIGNATURE_FIELDS.some((field) => !Object.hasOwn(signature, field))
  )
    return false;
  const permitted = new Set<string>([
    ...REQUIRED_SIGNATURE_FIELDS,
    ...OPTIONAL_SIGNATURE_FIELDS,
  ]);
  return Object.keys(signature).every((field) => permitted.has(field));
}

function evaluatedAt(value: VerifyOptions["at"]): {
  nanoseconds: bigint;
  iso: string;
} {
  if (typeof value === "string") {
    const parsed = parseRfc3339Instant(value);
    if (parsed === null) throw new Error("verification time is invalid");
    return { nanoseconds: parsed.epoch_nanoseconds, iso: value };
  }
  const milliseconds =
    value === undefined
      ? Date.now()
      : value instanceof Date
        ? value.getTime()
        : value;
  if (!Number.isFinite(milliseconds))
    throw new Error("verification time is invalid");
  const date = new Date(milliseconds);
  const exactMilliseconds = date.getTime();
  if (!Number.isFinite(exactMilliseconds))
    throw new Error("verification time is invalid");
  return {
    nanoseconds: BigInt(exactMilliseconds) * 1_000_000n,
    iso: date.toISOString(),
  };
}

function timestamp(
  value: unknown,
): { value: string; nanoseconds: bigint } | null {
  const parsed = parseRfc3339Instant(value);
  return typeof value === "string" && parsed !== null
    ? { value, nanoseconds: parsed.epoch_nanoseconds }
    : null;
}

function freshness(
  receipt: Record<string, unknown>,
  at: { nanoseconds: bigint; iso: string },
) {
  const expiry = record(receipt["expiry"]);
  const issuedAt = timestamp(expiry?.["issued_at"]);
  const recheckAt = timestamp(expiry?.["recheck_at"]);
  const expiresAt = timestamp(expiry?.["expires_at"]);
  if (issuedAt === null || recheckAt === null || expiresAt === null) {
    return {
      status: "unknown" as FreshnessStatus,
      evaluated_at: at.iso,
      reason: "receipt expiry timestamps are missing or malformed",
    };
  }
  const issued = issuedAt.nanoseconds;
  const recheck = recheckAt.nanoseconds;
  const expires = expiresAt.nanoseconds;
  if (recheck < issued || recheck >= expires || expires <= issued) {
    return {
      status: "unknown" as FreshnessStatus,
      evaluated_at: at.iso,
      issued_at: issuedAt.value,
      recheck_at: recheckAt.value,
      expires_at: expiresAt.value,
      reason: "receipt expiry timestamps have an invalid ordering",
    };
  }
  let status: FreshnessStatus;
  if (at.nanoseconds < issued) status = "not_yet_issued";
  else if (at.nanoseconds >= expires) status = "expired";
  else if (at.nanoseconds >= recheck) status = "recheck_due";
  else status = "fresh";
  return {
    status,
    evaluated_at: at.iso,
    issued_at: issuedAt.value,
    recheck_at: recheckAt.value,
    expires_at: expiresAt.value,
  };
}

/* ------------------------------------------------------------------ *
 * Verdict re-derivation (opt-in; see VerifyOptions.derive_verdict)     *
 * ------------------------------------------------------------------ */

function scopeFor(derive: boolean): VerificationScope {
  return derive ? "signature_envelope+decision_table" : "signature_envelope";
}

function statedDecision(
  receipt: Record<string, unknown>,
): VerificationDecision["stated"] {
  const codes = receipt["reason_codes"];
  const stated = {
    ...(typeof receipt["decision"] === "string"
      ? { verdict: receipt["decision"] }
      : {}),
    ...(Array.isArray(codes) && codes.every((code) => typeof code === "string")
      ? { reason_codes: [...(codes as string[])] }
      : {}),
  };
  return Object.keys(stated).length === 0 ? undefined : stated;
}

/** Set equality: the codes are what carry meaning, their array order is only determinism. */
function sameCodes(
  stated: readonly string[],
  derived: readonly string[],
): boolean {
  const left = [...stated].sort();
  const right = [...derived].sort();
  return (
    left.length === right.length &&
    left.every((code, index) => code === right[index])
  );
}

/**
 * Re-derive the receipt's verdict from its own facts and compare with what it claims.
 *
 * Every exit that is not a clean match sets `matches: false`, because a verifier that could not
 * answer the question must never read as one that answered it favourably. A receipt decided under a
 * decision-table version this build does not implement is refused for that reason and named: it is
 * not evidence of tampering, and pretending to re-derive it across a rule change would be worse than
 * saying so.
 */
function decisionResult(
  receipt: Record<string, unknown> | null,
): VerificationDecision {
  const supported = { supported_rule_version: CHECK_DECISION_RULE_VERSION };
  if (receipt === null) {
    return {
      ...supported,
      matches: false,
      error: "receipt is not a JSON object",
    };
  }
  const ruleVersion = receipt["decision_rule_version"];
  const stated = statedDecision(receipt);
  const head: VerificationDecision = {
    ...supported,
    ...(typeof ruleVersion === "string"
      ? { receipt_rule_version: ruleVersion }
      : {}),
    ...(stated === undefined ? {} : { stated }),
    matches: false,
  };
  if (typeof ruleVersion !== "string") {
    return { ...head, error: "receipt names no decision rule version" };
  }
  if (
    !(CHECK_DECISION_RULE_VERSIONS as readonly string[]).includes(ruleVersion)
  ) {
    return {
      ...head,
      error: `receipt was decided under ${ruleVersion}, which this verifier does not implement`,
    };
  }
  let derived;
  try {
    derived = deriveCheckDecision(receipt);
  } catch (error) {
    return {
      ...head,
      error:
        error instanceof ReceiptNotSelfDerivableError
          ? error.message
          : `verdict re-derivation failed: ${(error as Error).message}`,
    };
  }
  if (stated?.verdict === undefined || stated.reason_codes === undefined) {
    return {
      ...head,
      derived,
      error: "receipt states no verdict to compare against",
    };
  }
  if (stated.verdict !== derived.verdict) {
    return {
      ...head,
      derived,
      error: `receipt states ${stated.verdict} but its own facts re-derive as ${derived.verdict}`,
    };
  }
  if (!sameCodes(stated.reason_codes, derived.reason_codes)) {
    return {
      ...head,
      derived,
      error: `receipt states reason codes [${stated.reason_codes.join(", ")}] but its own facts re-derive [${derived.reason_codes.join(", ")}]`,
    };
  }
  return { ...head, derived, matches: true };
}

function decisionFields(
  receipt: Record<string, unknown> | null,
  derive: boolean,
): { decision?: VerificationDecision } {
  return derive ? { decision: decisionResult(receipt) } : {};
}

function malformedResult(
  receipt: Record<string, unknown> | null,
  at: { nanoseconds: bigint; iso: string },
  error: string,
  derive = false,
): VerificationResult {
  return {
    contract_version: "1",
    scope: scopeFor(derive),
    accepted: false,
    format: { valid: false, error },
    receipt: {
      ...(typeof receipt?.["proof_id"] === "string"
        ? { proof_id: receipt["proof_id"] }
        : {}),
    },
    canonicalization: {
      algorithm: KAVAL_CANONICALIZATION,
      valid: false,
      error: "receipt format is not canonicalizable",
    },
    cryptographic: { valid: false, error: "receipt format is invalid" },
    key: {
      found: false,
      lifecycle_status: "unknown",
      trusted: false,
      reason: "no valid signature key ID was available",
    },
    freshness: receipt
      ? freshness(receipt, at)
      : { status: "unknown", evaluated_at: at.iso },
    ...decisionFields(receipt, derive),
  };
}

/**
 * Verify the exact Ed25519 signature bytes and evaluate key trust/freshness independently.
 *
 * By default this validates only the SIGNATURE ENVELOPE — `scope: "signature_envelope"` — and says
 * nothing about what the receipt concluded. Pass `derive_verdict: true` and it also re-derives the
 * verdict from the receipt's own facts through the published `check-decision` table and requires the
 * two to agree; `scope` then reads `"signature_envelope+decision_table"` and a `decision` block is
 * present. The default is off so that every caller written before that option existed keeps its
 * result shape and its acceptance semantics unchanged.
 *
 * Neither scope is full ProofPacket schema validation: that remains the issuer/application's job and
 * must not be confused with cryptographic verification.
 */
export function verifyReceipt(
  receiptValue: unknown,
  keyDocument: unknown,
  options: VerifyOptions = {},
): VerificationResult {
  const at = evaluatedAt(options.at);
  const derive = options.derive_verdict === true;
  const receipt = record(receiptValue);
  if (!receipt)
    return malformedResult(null, at, "receipt must be a JSON object", derive);
  const signature = record(receipt["signature"]);
  if (!signature)
    return malformedResult(receipt, at, "receipt signature is missing", derive);
  if (!signatureFieldSetIsValid(signature)) {
    return malformedResult(
      receipt,
      at,
      "receipt signature has an invalid field set",
      derive,
    );
  }
  if (
    Object.hasOwn(signature, "signed_at") &&
    timestamp(signature["signed_at"]) === null
  ) {
    return malformedResult(
      receipt,
      at,
      "receipt signature signed_at is not an RFC 3339 instant",
      derive,
    );
  }
  /*
   * `signed_at` lives INSIDE the signature block, and the canonicalizer strips that whole block
   * before hashing — so the bytes never covered it. Until this check existed, rewriting `signed_at`
   * to any other instant still returned `accepted: true`, on the one field a holder reads to answer
   * "when was this attested?".
   *
   * Binding it to `checked_at` is what authenticates it, because `checked_at` IS in the signed
   * bytes. The issuer passes one value for both (`pipeline.ts` hands `checkedAt` straight to
   * `signCheckReceipt`), so this is a statement of an existing invariant rather than a new
   * requirement, and every receipt ever issued satisfies it. Tampering now has to move `checked_at`
   * too, which breaks the signature.
   *
   * Scoped to receipts that HAVE both fields: a ProofPacket seals `{algorithm, key_id, signature}`
   * with no `signed_at` and no `checked_at`, and must keep verifying untouched.
   */
  if (
    Object.hasOwn(signature, "signed_at") &&
    typeof receipt["checked_at"] === "string"
  ) {
    if (signature["signed_at"] !== receipt["checked_at"]) {
      return malformedResult(
        receipt,
        at,
        "receipt signature signed_at does not match the signed checked_at",
        derive,
      );
    }
  }
  if (signature["algorithm"] !== "Ed25519") {
    return malformedResult(
      receipt,
      at,
      "only Ed25519 receipt signatures are supported",
      derive,
    );
  }
  const keyId = signature["key_id"];
  if (typeof keyId !== "string" || !keyId.trim() || keyId.length > 128) {
    return malformedResult(
      receipt,
      at,
      "receipt signature key_id is invalid",
      derive,
    );
  }
  let signatureBytes: Buffer;
  try {
    signatureBytes = decodeCanonicalBase64Url(
      signature["signature"],
      64,
      "receipt Ed25519 signature",
    );
  } catch (error) {
    return malformedResult(receipt, at, (error as Error).message, derive);
  }

  let canonicalBytes: Uint8Array;
  try {
    canonicalBytes = canonicalUnsignedReceiptBytes(receipt);
  } catch (error) {
    return malformedResult(receipt, at, (error as Error).message, derive);
  }
  const digest = createHash("sha256").update(canonicalBytes).digest("hex");
  const canonicalization = {
    algorithm: KAVAL_CANONICALIZATION,
    valid: true,
    byte_length: canonicalBytes.byteLength,
    sha256: `sha256:${digest}`,
  } as const;
  const receiptIdentity = {
    ...(typeof receipt["proof_id"] === "string"
      ? { proof_id: receipt["proof_id"] }
      : {}),
    algorithm: "Ed25519",
    key_id: keyId,
  };

  let key;
  try {
    key = verificationKeyFromDocument(keyDocument, keyId);
  } catch (error) {
    return {
      contract_version: "1",
      scope: scopeFor(derive),
      accepted: false,
      format: { valid: true },
      receipt: receiptIdentity,
      canonicalization,
      cryptographic: {
        valid: false,
        error: `verification key is malformed: ${(error as Error).message}`,
      },
      key: {
        found: false,
        key_id: keyId,
        lifecycle_status: "unknown",
        trusted: false,
        reason: `verification key document is malformed: ${(error as Error).message}`,
      },
      freshness: freshness(receipt, at),
      ...decisionFields(receipt, derive),
    };
  }
  if (!key) {
    return {
      contract_version: "1",
      scope: scopeFor(derive),
      accepted: false,
      format: { valid: true },
      receipt: receiptIdentity,
      canonicalization,
      cryptographic: {
        valid: false,
        error: `unknown verification key ${keyId}`,
      },
      key: {
        found: false,
        key_id: keyId,
        lifecycle_status: "unknown",
        trusted: false,
        reason: "the key document does not contain this immutable key ID",
      },
      freshness: freshness(receipt, at),
      ...decisionFields(receipt, derive),
    };
  }

  let cryptographicallyValid = false;
  let cryptoError: string | undefined;
  try {
    const publicKey = createPublicKey({
      key: {
        kty: "OKP",
        crv: "Ed25519",
        x: key.public_key.x,
      },
      format: "jwk",
    });
    if (publicKey.asymmetricKeyType !== "ed25519") {
      throw new Error("resolved JWK is not an Ed25519 public key");
    }
    cryptographicallyValid = verifySignature(
      null,
      canonicalBytes,
      publicKey,
      signatureBytes,
    );
    if (!cryptographicallyValid)
      cryptoError = "Ed25519 signature does not match canonical bytes";
  } catch (error) {
    cryptoError = `Ed25519 verification failed: ${(error as Error).message}`;
  }

  const lifecycleStatus = key.lifecycle?.status ?? "unknown";
  const canonicalizationMatches =
    key.canonicalization === KAVAL_CANONICALIZATION;
  const lifecycleTrusted =
    lifecycleStatus === "active" || lifecycleStatus === "retired";
  const trusted = canonicalizationMatches && lifecycleTrusted;
  let trustReason: string;
  if (!canonicalizationMatches) {
    trustReason =
      key.canonicalization === undefined
        ? "key does not declare a canonicalization contract"
        : `key declares unsupported canonicalization ${key.canonicalization}`;
  } else if (lifecycleStatus === "active") {
    trustReason = "active key";
  } else if (lifecycleStatus === "retired") {
    trustReason = "retired key retained for historical verification";
  } else if (lifecycleStatus === "revoked") {
    trustReason =
      "revoked keys remain cryptographically checkable but are not trusted";
  } else if (lifecycleStatus === "compromised") {
    trustReason =
      "compromised keys remain cryptographically checkable but no self-asserted issuance time is trusted";
  } else {
    trustReason = "key lifecycle is unspecified";
  }

  /*
   * The verdict half, when it was asked for.
   *
   * It is computed AFTER the signature so the two answers stay separable in the result — a holder
   * must be able to see "the bytes are authentic but the verdict does not follow from them" as a
   * distinct outcome from "these bytes were never signed by us". It gates `accepted` in one
   * direction only: it can refuse, never rescue. A receipt whose signature fails is not saved by
   * re-deriving cleanly.
   */
  const decision = derive ? decisionResult(receipt) : undefined;

  return {
    contract_version: "1",
    scope: scopeFor(derive),
    accepted: cryptographicallyValid && trusted && (decision?.matches ?? true),
    format: { valid: true },
    receipt: receiptIdentity,
    canonicalization,
    cryptographic: {
      valid: cryptographicallyValid,
      ...(cryptoError === undefined ? {} : { error: cryptoError }),
    },
    key: {
      found: true,
      key_id: keyId,
      lifecycle_status: lifecycleStatus,
      ...(key.canonicalization === undefined
        ? {}
        : { canonicalization: key.canonicalization }),
      trusted,
      reason: key.lifecycle?.reason
        ? `${trustReason}: ${key.lifecycle.reason}`
        : trustReason,
      ...(key.lifecycle?.status_changed_at === undefined
        ? {}
        : { status_changed_at: key.lifecycle.status_changed_at }),
    },
    freshness: freshness(receipt, at),
    ...(decision === undefined ? {} : { decision }),
  };
}

export function verifyReceiptText(
  receiptJson: string,
  keyDocumentJson: string,
  options: VerifyOptions = {},
): VerificationResult {
  const at = evaluatedAt(options.at);
  const derive = options.derive_verdict === true;
  const forward = { at: at.iso, ...(derive ? { derive_verdict: true } : {}) };
  let receipt: unknown;
  try {
    receipt = parseJsonStrict(receiptJson);
  } catch (error) {
    return malformedResult(
      null,
      at,
      `receipt JSON is invalid: ${(error as Error).message}`,
      derive,
    );
  }
  let keyDocument: unknown;
  try {
    keyDocument = parseJsonStrict(keyDocumentJson);
  } catch (error) {
    const message = `verification key JSON is invalid: ${(error as Error).message}`;
    const result = verifyReceipt(receipt, {}, forward);
    return {
      ...result,
      cryptographic: { valid: false, error: message },
      key: {
        ...result.key,
        found: false,
        lifecycle_status: "unknown",
        trusted: false,
        reason: message,
      },
      accepted: false,
    };
  }
  return verifyReceipt(receipt, keyDocument, forward);
}

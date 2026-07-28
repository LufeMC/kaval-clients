/**
 * `@usekaval/kaval/verify` — the offline receipt verifier.
 *
 * Nothing reachable from this entry point performs I/O of any kind: no `fetch`, no `node:http`,
 * no `node:https`, no sockets. It reads a receipt and a key document you already hold and answers
 * three separate questions — is the Ed25519 signature over the exact canonical bytes, is the key
 * trusted, and is the receipt fresh at the instant you name. That is the whole point of the
 * subpath, and `test/verify/no-network.test.ts` holds the import graph to it.
 *
 * Live HTTPS key discovery lives on `@usekaval/kaval/verify/discovery`, one import away, so that
 * choosing it is explicit.
 */

export {
  canonicalUnsignedReceiptBytes,
  canonicalUnsignedReceiptJson,
  MAX_JSON_NUMBER_CHARACTERS,
  parseJsonStrict,
  stableCanonicalJson,
} from "./canonicalize.js";
export {
  parseVerificationKey,
  verificationKeyFromDocument,
} from "./key-document.js";
export {
  isRfc3339Timestamp,
  parseRfc3339Instant,
  rfc3339TimestampMilliseconds,
  rfc3339TimestampNanoseconds,
  type Rfc3339Instant,
} from "./rfc3339.js";
export {
  KAVAL_CANONICALIZATION,
  type FreshnessStatus,
  type JsonValue,
  type KeyLifecycle,
  type KeyLifecycleStatus,
  type VerificationKey,
  type VerificationResult,
  type VerifyOptions,
} from "./types.js";
export { extractReceipt, verifyReceipt, verifyReceiptText } from "./verify.js";

/**
 * `@usekaval/kaval/verify` — the offline verifier: everything Kaval signs, checked without Kaval.
 *
 * Nothing reachable from this entry point performs I/O of any kind: no `fetch`, no `node:http`,
 * no `node:https`, no sockets. It reads a receipt and a key document you already hold and answers
 * three separate questions — is the Ed25519 signature over the exact canonical bytes, is the key
 * trusted, and is the receipt fresh at the instant you name. That is the whole point of the
 * subpath, and `test/verify/no-network.test.ts` holds the import graph to it.
 *
 * `verifyWebhookSignature` is here for the same reason: authenticating an inbound `fact_state.delta`
 * is a pure HMAC over bytes you were handed, and a receiver that had to reach the network to decide
 * whether a request is genuine would be a worse receiver. It is deliberately NOT re-exported from
 * the package root — the root entry runs in browsers and edge runtimes on the global `fetch` alone,
 * and hoisting a `node:crypto` import into it would break that.
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
export {
  DEFAULT_WEBHOOK_TOLERANCE_SECONDS,
  verifyWebhookSignature,
  WEBHOOK_SIGNATURE_VERSION,
  WEBHOOK_SIGNED_CONTENT,
  type VerifyWebhookSignatureInput,
  type WebhookHeaderSource,
  type WebhookRejectionReason,
  type WebhookSignatureAccepted,
  type WebhookSignatureRejected,
  type WebhookSignatureResult,
} from "./webhook.js";

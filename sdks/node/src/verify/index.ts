/**
 * `@usekaval/kaval/verify` — the offline verifier: everything Kaval signs, checked without Kaval.
 *
 * Nothing reachable from this entry point performs I/O of any kind: no `fetch`, no `node:http`,
 * no `node:https`, no sockets. It reads a receipt and a key document you already hold and answers
 * four separate questions — is the Ed25519 signature over the exact canonical bytes, is the key
 * trusted, is the receipt fresh at the instant you name, and (only when you pass
 * `derive_verdict: true`) does the receipt's stated ALLOW/REVIEW/BLOCK actually follow from the
 * facts the receipt itself carries. That is the whole point of the subpath, and
 * `test/verify/no-network.test.ts` holds the import graph to it.
 *
 * The fourth question is what makes a receipt an appeal packet rather than a signed assertion. The
 * The decision tables live in `./decision.js`. The verifier supports rules 1.0.0, 1.1.0, and 2.0.0.
 * Rule 2.0.0 also derives the signed `ALLOW` calibration gate. The issuer runs the same logic.
 * Shared conformance vectors keep both implementations aligned.
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
  CHECK_ACTION_CLASSIFICATION_STATUSES,
  CHECK_ALLOW_GATE_EVALUATION_STATUSES,
  CHECK_ALLOW_GATE_MODES,
  CHECK_ALLOW_GATE_REASON_CODES,
  CHECK_ALLOW_GATE_STATUSES,
  CHECK_DECISION_RULE_VERSION,
  CHECK_DECISION_RULE_LATEST_VERSION,
  CHECK_DECISION_RULE_V2_VERSION,
  CHECK_DECISION_RULE_VERSIONS,
  CHECK_DECISION_V2_REASON_CODES,
  CHECK_FACT_METHODS,
  CHECK_FACT_STATES,
  CHECK_FRESHNESS_FAILURES,
  CHECK_MATERIALITIES,
  CHECK_REASON_CODES,
  CHECK_RECEIPT_V2_VERSION,
  CHECK_VERDICTS,
  ReceiptNotSelfDerivableError,
  checkDecisionInputFromReceipt,
  decideCheck,
  deriveCheckDecision,
  deriveCheckDecisionV2,
  parseCheckReceiptV2DecisionFields,
  type CheckActionClassification,
  type CheckActionClassificationStatus,
  type CheckAllowCalibrationBinding,
  type CheckAllowGateEvaluationStatus,
  type CheckAllowGateMode,
  type CheckAllowGateReasonCode,
  type CheckAllowGateReceiptFields,
  type CheckAllowGateStatus,
  type CheckAllowPolicyBinding,
  type CheckDecision,
  type CheckDecisionV2,
  type CheckDecisionV2ReasonCode,
  type CheckDecisionFact,
  type CheckDecisionOptions,
  type CheckDecisionRuleVersion,
  type CheckFactMethod,
  type CheckFactState,
  type CheckFreshnessFailure,
  type CheckMateriality,
  type CheckReasonCode,
  type CheckReceiptV2DecisionFields,
  type CheckVerdict,
  type DerivedCheckDecision,
} from "./decision.js";
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
  type VerificationDecision,
  type VerificationKey,
  type VerificationResult,
  type VerificationScope,
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

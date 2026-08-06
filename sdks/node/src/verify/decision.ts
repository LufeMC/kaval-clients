import { parseRfc3339Instant } from "./rfc3339.js";

/**
 * `check-decision/1.1.0` — THE PUBLISHED DECISION TABLE, EXECUTABLE.
 *
 * A signed receipt exists to be an exhibit. Until this module shipped, a holder could check the
 * SIGNATURE offline but had to run Kaval's server code to re-derive the VERDICT — so a skeptic could
 * fairly answer "to check your verdict I must run your software", which is exactly the objection an
 * appeal packet exists to remove. The table below was already published as documentation; this file
 * is that same table as code, and it is the code the issuer runs.
 *
 * THIS IS THE SINGLE SOURCE OF TRUTH, NOT A COPY OF ONE.
 * `apps/server/src/check/decide.ts` re-exports these bindings; it does not restate them. A
 * reimplementation that drifted would accept verdicts the server never reaches, which is worse than
 * publishing nothing at all, so `apps/server/test/check-decision-shared-source.test.ts` fails if the
 * server's `decideCheck` is ever anything but the function object exported here — and fails again if
 * the receipt-issuing pipeline ever routes around it.
 *
 * COMPATIBILITY SURFACE. Because verifiers a customer runs now execute this table, changing a row
 * changes what those verifiers accept: a receipt issued under a new table would be REFUSED by every
 * deployed verifier that still knows the old one. That is a BREAKING CHANGE, deliberately made
 * expensive — for an audit-grade artifact the decision table *should* be hard to change quietly. The
 * procedure is: bump `CHECK_DECISION_RULE_VERSION`, publish the new table, and keep accepting the
 * old one for receipts that name it. Nothing here may change under the existing version string.
 *
 * ZERO DEPENDENCIES, ON PURPOSE. The enums below are restated rather than imported from
 * `@kaval/contracts`: this package is mirrored into the public Apache-2.0 thin client, where nothing
 * from the private repo exists. `apps/server/src/check/contracts.ts` asserts at COMPILE TIME that
 * its own `Materiality` / `FactStatus` / `FreshnessFailure` are the same sets in both directions, so
 * adding an internal value without publishing it here fails the build rather than a receipt.
 *
 * | # | condition                                                                        | verdict |
 * |---|----------------------------------------------------------------------------------|---------|
 * | 1 | any high/critical fact is `changed`                                               | BLOCK   |
 * | 2 | any uncontested critical fact is `unknown`                                        | BLOCK   |
 * | 3 | any contested fact is `unknown`                                                   | REVIEW  |
 * | 4 | any other changed/unknown/timeout/stale-pending fact, or compile uncertainty       | REVIEW  |
 * | 5 | every material fact `holds` on a fresh basis                                      | ALLOW   |
 *
 * Top-down, FIRST MATCH WINS. Row 4 is vacuously true for an empty fact list; a check that
 * identified no facts at all must therefore set `compilationUncertain` (row 3) rather than rely on
 * the table to fail closed for it.
 */

/** Published with every new receipt so its verdict stays re-derivable from the fact list. */
export const CHECK_DECISION_RULE_VERSION = "check-decision/1.1.0";
/** Frozen but not yet activated by the issuer. Rule 2 adds the signed `ALLOW` calibration gate. */
export const CHECK_DECISION_RULE_V2_VERSION = "check-decision/2.0.0" as const;
/** Latest rule this verifier can execute. The issuer activates it in a separate integration step. */
export const CHECK_DECISION_RULE_LATEST_VERSION =
  CHECK_DECISION_RULE_V2_VERSION;
export const CHECK_RECEIPT_V2_VERSION = "check-receipt/2.0.0" as const;
export const CHECK_DECISION_RULE_VERSIONS = [
  "check-decision/1.0.0",
  CHECK_DECISION_RULE_VERSION,
  CHECK_DECISION_RULE_V2_VERSION,
] as const;
export type CheckDecisionRuleVersion =
  (typeof CHECK_DECISION_RULE_VERSIONS)[number];

/** The entire taxonomy. Eight codes, no synonyms, no free text. */
export const CHECK_REASON_CODES = [
  "ALL_FACTS_HOLD",
  "FACT_CHANGED",
  "FACT_EXPIRED",
  "FACT_UNKNOWN",
  "SOURCE_UPDATED_PENDING_REVIEW",
  "SOURCE_UNREACHABLE",
  "NEW_FACT_UNVERIFIED",
  "COMPILATION_UNCERTAIN",
] as const;
export type CheckReasonCode = (typeof CHECK_REASON_CODES)[number];

/** Why rule 2 did not permit a candidate `ALLOW` to remain `ALLOW`. */
export const CHECK_ALLOW_GATE_REASON_CODES = [
  "ALLOW_ACTION_UNCLASSIFIED",
  "ALLOW_POLICY_UNBOUND",
  "ALLOW_CALIBRATION_UNBOUND",
  "ALLOW_CALIBRATION_INSUFFICIENT",
  "ALLOW_CALIBRATION_EXPIRED",
  "ALLOW_GATE_UNAVAILABLE",
] as const;
export type CheckAllowGateReasonCode =
  (typeof CHECK_ALLOW_GATE_REASON_CODES)[number];

export const CHECK_DECISION_V2_REASON_CODES = [
  ...CHECK_REASON_CODES,
  ...CHECK_ALLOW_GATE_REASON_CODES,
] as const;
export type CheckDecisionV2ReasonCode =
  (typeof CHECK_DECISION_V2_REASON_CODES)[number];

export const CHECK_ALLOW_GATE_STATUSES = [
  "not_applicable",
  "passed",
  "downgraded",
] as const;
export type CheckAllowGateStatus = (typeof CHECK_ALLOW_GATE_STATUSES)[number];

export const CHECK_ALLOW_GATE_MODES = ["production", "demo"] as const;
export type CheckAllowGateMode = (typeof CHECK_ALLOW_GATE_MODES)[number];

export const CHECK_ALLOW_GATE_EVALUATION_STATUSES = [
  "available",
  "unavailable",
] as const;
export type CheckAllowGateEvaluationStatus =
  (typeof CHECK_ALLOW_GATE_EVALUATION_STATUSES)[number];

export const CHECK_ACTION_CLASSIFICATION_STATUSES = [
  "classified",
  "unclassified",
] as const;
export type CheckActionClassificationStatus =
  (typeof CHECK_ACTION_CLASSIFICATION_STATUSES)[number];

export const CHECK_VERDICTS = ["ALLOW", "REVIEW", "BLOCK"] as const;
export type CheckVerdict = (typeof CHECK_VERDICTS)[number];

/** How a fact's status was obtained. Mirrors the receipt's per-fact `method`. */
export const CHECK_FACT_METHODS = ["state", "live", "timeout"] as const;
export type CheckFactMethod = (typeof CHECK_FACT_METHODS)[number];

/** The public, three-valued projection of an internal claim assessment. */
export const CHECK_FACT_STATES = ["holds", "changed", "unknown"] as const;
export type CheckFactState = (typeof CHECK_FACT_STATES)[number];

export const CHECK_MATERIALITIES = [
  "low",
  "medium",
  "high",
  "critical",
] as const;
export type CheckMateriality = (typeof CHECK_MATERIALITIES)[number];

/** Why a stored fact state could not be served, published as part of the receipt. */
export const CHECK_FRESHNESS_FAILURES = [
  "stale",
  "dormant",
  "basis_superseded",
  "source_unreachable",
  "ttl_expired",
] as const;
export type CheckFreshnessFailure = (typeof CHECK_FRESHNESS_FAILURES)[number];

export interface CheckDecisionFact {
  materiality: CheckMateriality;
  status: CheckFactState;
  /** How the status was obtained. `timeout` means the live path ran out of `max_wait_ms`. */
  method: CheckFactMethod;
  /** Internal temporal state when known — the only thing that distinguishes EXPIRED from CHANGED. */
  temporalState?: string | null | undefined;
  /** Why a stored row could not be served. Drives SOURCE_UNREACHABLE. */
  freshnessFailure?: CheckFreshnessFailure | undefined;
  /** A known fact whose basis moved and whose re-evaluation has not finished yet. */
  stalePending?: boolean | undefined;
  /** True when no stored state existed and the live path did not establish one. */
  novel?: boolean | undefined;
  /** True when at least one recorded source contests the conclusion's backing. */
  contested?: boolean | undefined;
}

export interface CheckDecisionOptions {
  /** Claim extraction failed or produced nothing usable for the submitted action. */
  compilationUncertain?: boolean | undefined;
  /** Omit for the latest table. Receipt projection sets the version named by the artifact. */
  ruleVersion?: CheckDecisionRuleVersion | undefined;
}

export interface CheckDecision {
  verdict: CheckVerdict;
  reason_codes: CheckReasonCode[];
  decision_rule_version: string;
}

export interface CheckActionClassification {
  status: CheckActionClassificationStatus;
  action_class: string | null;
  classifier_version: string;
}

export interface CheckAllowPolicyBinding {
  id: string;
  version: string;
  action_class: string;
  minimum_sample_size: number;
  maximum_false_allow_upper_bound_bps: number;
  valid_from: string;
  valid_until: string | null;
  demo_only: boolean;
}

export interface CheckAllowCalibrationBinding {
  id: string;
  policy_id: string;
  policy_version: string;
  action_class: string;
  sample_size: number;
  false_allow_upper_bound_bps: number;
  evaluated_at: string;
  expires_at: string;
  demo_only: boolean;
}

export interface CheckAllowGateReceiptFields {
  mode: CheckAllowGateMode;
  evaluation_status: CheckAllowGateEvaluationStatus;
  status: CheckAllowGateStatus;
  reason_codes: CheckAllowGateReasonCode[];
}

/** The strict rule-2 fields carried by a `check-receipt/2.0.0` artifact. */
export interface CheckReceiptV2DecisionFields {
  receipt_version: typeof CHECK_RECEIPT_V2_VERSION;
  decision_rule_version: typeof CHECK_DECISION_RULE_V2_VERSION;
  checked_at: string;
  candidate_decision: CheckVerdict;
  decision: CheckVerdict;
  reason_codes: CheckDecisionV2ReasonCode[];
  action_classification: CheckActionClassification;
  policy_binding: CheckAllowPolicyBinding | null;
  calibration_binding: CheckAllowCalibrationBinding | null;
  gate: CheckAllowGateReceiptFields;
}

/** The complete result that an offline rule-2 verifier derives. */
export interface CheckDecisionV2 {
  verdict: CheckVerdict;
  reason_codes: CheckDecisionV2ReasonCode[];
  decision_rule_version: typeof CHECK_DECISION_RULE_V2_VERSION;
  candidate_decision: CheckVerdict;
  candidate_reason_codes: CheckReasonCode[];
  gate: {
    status: CheckAllowGateStatus;
    reason_codes: CheckAllowGateReasonCode[];
  };
}

export type DerivedCheckDecision = CheckDecision | CheckDecisionV2;

function isBlockingMateriality(materiality: CheckMateriality): boolean {
  return materiality === "high" || materiality === "critical";
}

/**
 * Reason codes are evidence, not commentary: every code emitted must be traceable to a fact row (or
 * to compilation) in the same receipt. Order is stable — table order, then fact order — so two
 * identical decision inputs produce the same reason-code order. Receipt IDs and times remain unique.
 */
function reasonCodes(
  facts: readonly CheckDecisionFact[],
  verdict: CheckVerdict,
  compilationUncertain: boolean,
): CheckReasonCode[] {
  if (verdict === "ALLOW") return ["ALL_FACTS_HOLD"];
  const codes = new Set<CheckReasonCode>();
  if (compilationUncertain) codes.add("COMPILATION_UNCERTAIN");
  for (const fact of facts) {
    if (fact.status === "changed") {
      codes.add(
        fact.temporalState === "expired" ? "FACT_EXPIRED" : "FACT_CHANGED",
      );
      continue;
    }
    if (fact.stalePending === true) {
      codes.add("SOURCE_UPDATED_PENDING_REVIEW");
      continue;
    }
    if (fact.status === "unknown") {
      if (fact.freshnessFailure === "source_unreachable")
        codes.add("SOURCE_UNREACHABLE");
      else if (fact.novel === true || fact.method === "timeout")
        codes.add("NEW_FACT_UNVERIFIED");
      else codes.add("FACT_UNKNOWN");
    }
  }
  // A non-ALLOW verdict always names at least one cause. The only way to reach here with nothing
  // recorded is a `holds` fact that timed out mid-revalidation, which is exactly UNKNOWN-shaped.
  if (codes.size === 0) codes.add("FACT_UNKNOWN");
  return [...codes];
}

function decideCheckForVersion(
  facts: readonly CheckDecisionFact[],
  options: CheckDecisionOptions,
  version: CheckDecisionRuleVersion,
): CheckDecision {
  const compilationUncertain = options.compilationUncertain === true;

  const verdict: CheckVerdict = (() => {
    // Row 1 — a material fact that CHANGED is the whole product; it blocks before anything else.
    if (
      facts.some(
        (fact) =>
          fact.status === "changed" && isBlockingMateriality(fact.materiality),
      )
    ) {
      return "BLOCK";
    }
    // Version 1.0.0 blocked every critical unknown. Version 1.1.0 stops a named contest at REVIEW.
    if (
      facts.some(
        (fact) =>
          fact.status === "unknown" &&
          fact.materiality === "critical" &&
          (version === "check-decision/1.0.0" || fact.contested !== true),
      )
    ) {
      return "BLOCK";
    }
    // Rows 3 and 4 — a named evidence contest stops at REVIEW, regardless of materiality.
    if (
      compilationUncertain ||
      facts.some(
        (fact) =>
          fact.status !== "holds" ||
          fact.method === "timeout" ||
          fact.stalePending === true,
      )
    ) {
      return "REVIEW";
    }
    // Row 4.
    return "ALLOW";
  })();

  return {
    verdict,
    reason_codes: reasonCodes(facts, verdict, compilationUncertain),
    decision_rule_version: version,
  };
}

export function decideCheck(
  facts: readonly CheckDecisionFact[],
  options: CheckDecisionOptions = {},
): CheckDecision {
  return decideCheckForVersion(
    facts,
    options,
    options.ruleVersion ?? CHECK_DECISION_RULE_VERSION,
  );
}

/* ------------------------------------------------------------------ *
 * Offline re-derivation                                                *
 * ------------------------------------------------------------------ */

/** A receipt that predates the discriminators cannot be re-derived; it is refused, never guessed. */
export class ReceiptNotSelfDerivableError extends Error {
  constructor(readonly reason: string) {
    super(`this receipt cannot be re-derived offline: ${reason}`);
    this.name = "ReceiptNotSelfDerivableError";
  }
}

function objectOrNull(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function memberOf<T extends string>(
  values: readonly T[],
  value: unknown,
): value is T {
  return (
    typeof value === "string" && (values as readonly string[]).includes(value)
  );
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const expectedSet = new Set(expected);
  const unknown = Object.keys(value).filter((key) => !expectedSet.has(key));
  const missing = expected.filter((key) => !Object.hasOwn(value, key));
  if (unknown.length > 0 || missing.length > 0) {
    const parts = [
      ...(missing.length === 0 ? [] : [`missing ${missing.join(", ")}`]),
      ...(unknown.length === 0 ? [] : [`unknown ${unknown.join(", ")}`]),
    ];
    throw new ReceiptNotSelfDerivableError(
      `${label} has an invalid field set: ${parts.join("; ")}`,
    );
  }
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum
  ) {
    throw new ReceiptNotSelfDerivableError(`${label} is not valid text`);
  }
  return value;
}

function boundedInteger(
  value: unknown,
  label: string,
  maximum: number,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) > maximum
  ) {
    throw new ReceiptNotSelfDerivableError(
      `${label} is not a valid nonnegative integer`,
    );
  }
  return value as number;
}

function instant(
  value: unknown,
  label: string,
): { text: string; nanoseconds: bigint } {
  const parsed = parseRfc3339Instant(value);
  if (parsed === null) {
    throw new ReceiptNotSelfDerivableError(
      `${label} is not an RFC 3339 instant`,
    );
  }
  return { text: value as string, nanoseconds: parsed.epoch_nanoseconds };
}

function stringCodes<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): T[] {
  if (
    !Array.isArray(value) ||
    !value.every((entry) => memberOf(allowed, entry))
  ) {
    throw new ReceiptNotSelfDerivableError(
      `${label} contains a code this contract does not define`,
    );
  }
  if (new Set(value).size !== value.length) {
    throw new ReceiptNotSelfDerivableError(
      `${label} contains a duplicate code`,
    );
  }
  return [...value] as T[];
}

function parseActionClassification(value: unknown): CheckActionClassification {
  const classification = objectOrNull(value);
  if (classification === null) {
    throw new ReceiptNotSelfDerivableError(
      "action classification is not a JSON object",
    );
  }
  exactKeys(
    classification,
    ["status", "action_class", "classifier_version"],
    "action classification",
  );
  const status = classification["status"];
  if (!memberOf(CHECK_ACTION_CLASSIFICATION_STATUSES, status)) {
    throw new ReceiptNotSelfDerivableError(
      "action classification has an unknown status",
    );
  }
  const actionClass = classification["action_class"];
  if (
    (status === "classified" &&
      (typeof actionClass !== "string" ||
        actionClass.length === 0 ||
        actionClass.length > 256)) ||
    (status === "unclassified" && actionClass !== null)
  ) {
    throw new ReceiptNotSelfDerivableError(
      "action classification status does not match its action class",
    );
  }
  return {
    status,
    action_class: actionClass as string | null,
    classifier_version: boundedText(
      classification["classifier_version"],
      "action classifier version",
      128,
    ),
  };
}

function parsePolicyBinding(value: unknown): CheckAllowPolicyBinding | null {
  if (value === null) return null;
  const binding = objectOrNull(value);
  if (binding === null) {
    throw new ReceiptNotSelfDerivableError(
      "policy binding is not a JSON object or null",
    );
  }
  exactKeys(
    binding,
    [
      "id",
      "version",
      "action_class",
      "minimum_sample_size",
      "maximum_false_allow_upper_bound_bps",
      "valid_from",
      "valid_until",
      "demo_only",
    ],
    "policy binding",
  );
  const validFrom = instant(binding["valid_from"], "policy valid_from").text;
  const validUntilValue = binding["valid_until"];
  const validUntil =
    validUntilValue === null
      ? null
      : instant(validUntilValue, "policy valid_until").text;
  if (
    validUntil !== null &&
    instant(validUntil, "policy valid_until").nanoseconds <=
      instant(validFrom, "policy valid_from").nanoseconds
  ) {
    throw new ReceiptNotSelfDerivableError(
      "policy validity interval is empty or reversed",
    );
  }
  if (typeof binding["demo_only"] !== "boolean") {
    throw new ReceiptNotSelfDerivableError("policy demo_only is not boolean");
  }
  return {
    id: boundedText(binding["id"], "policy id", 256),
    version: boundedText(binding["version"], "policy version", 128),
    action_class: boundedText(
      binding["action_class"],
      "policy action class",
      256,
    ),
    minimum_sample_size: boundedInteger(
      binding["minimum_sample_size"],
      "policy minimum sample size",
      Number.MAX_SAFE_INTEGER,
    ),
    maximum_false_allow_upper_bound_bps: boundedInteger(
      binding["maximum_false_allow_upper_bound_bps"],
      "policy maximum false-allow upper bound",
      10_000,
    ),
    valid_from: validFrom,
    valid_until: validUntil,
    demo_only: binding["demo_only"],
  };
}

function parseCalibrationBinding(
  value: unknown,
): CheckAllowCalibrationBinding | null {
  if (value === null) return null;
  const binding = objectOrNull(value);
  if (binding === null) {
    throw new ReceiptNotSelfDerivableError(
      "calibration binding is not a JSON object or null",
    );
  }
  exactKeys(
    binding,
    [
      "id",
      "policy_id",
      "policy_version",
      "action_class",
      "sample_size",
      "false_allow_upper_bound_bps",
      "evaluated_at",
      "expires_at",
      "demo_only",
    ],
    "calibration binding",
  );
  if (typeof binding["demo_only"] !== "boolean") {
    throw new ReceiptNotSelfDerivableError(
      "calibration demo_only is not boolean",
    );
  }
  const evaluatedAt = instant(
    binding["evaluated_at"],
    "calibration evaluated_at",
  ).text;
  const expiresAt = instant(
    binding["expires_at"],
    "calibration expires_at",
  ).text;
  if (
    instant(expiresAt, "calibration expires_at").nanoseconds <=
    instant(evaluatedAt, "calibration evaluated_at").nanoseconds
  ) {
    throw new ReceiptNotSelfDerivableError(
      "calibration validity interval is empty or reversed",
    );
  }
  return {
    id: boundedText(binding["id"], "calibration id", 256),
    policy_id: boundedText(binding["policy_id"], "calibration policy id", 256),
    policy_version: boundedText(
      binding["policy_version"],
      "calibration policy version",
      128,
    ),
    action_class: boundedText(
      binding["action_class"],
      "calibration action class",
      256,
    ),
    sample_size: boundedInteger(
      binding["sample_size"],
      "calibration sample size",
      Number.MAX_SAFE_INTEGER,
    ),
    false_allow_upper_bound_bps: boundedInteger(
      binding["false_allow_upper_bound_bps"],
      "calibration false-allow upper bound",
      10_000,
    ),
    evaluated_at: evaluatedAt,
    expires_at: expiresAt,
    demo_only: binding["demo_only"],
  };
}

function parseAllowGate(value: unknown): CheckAllowGateReceiptFields {
  const gate = objectOrNull(value);
  if (gate === null)
    throw new ReceiptNotSelfDerivableError("allow gate is not a JSON object");
  exactKeys(
    gate,
    ["mode", "evaluation_status", "status", "reason_codes"],
    "allow gate",
  );
  const mode = gate["mode"];
  const evaluationStatus = gate["evaluation_status"];
  const status = gate["status"];
  if (!memberOf(CHECK_ALLOW_GATE_MODES, mode)) {
    throw new ReceiptNotSelfDerivableError("allow gate has an unknown mode");
  }
  if (!memberOf(CHECK_ALLOW_GATE_EVALUATION_STATUSES, evaluationStatus)) {
    throw new ReceiptNotSelfDerivableError(
      "allow gate has an unknown evaluation status",
    );
  }
  if (!memberOf(CHECK_ALLOW_GATE_STATUSES, status)) {
    throw new ReceiptNotSelfDerivableError("allow gate has an unknown status");
  }
  return {
    mode,
    evaluation_status: evaluationStatus,
    status,
    reason_codes: stringCodes(
      gate["reason_codes"],
      CHECK_ALLOW_GATE_REASON_CODES,
      "allow gate reason codes",
    ),
  };
}

/** Parse the closed rule-2 decision fragment without trusting application types. */
export function parseCheckReceiptV2DecisionFields(
  receipt: unknown,
): CheckReceiptV2DecisionFields {
  const document = objectOrNull(receipt);
  if (document === null)
    throw new ReceiptNotSelfDerivableError("it is not a JSON object");
  if (document["receipt_version"] !== CHECK_RECEIPT_V2_VERSION) {
    throw new ReceiptNotSelfDerivableError(
      `it does not name receipt version ${CHECK_RECEIPT_V2_VERSION}`,
    );
  }
  if (document["decision_rule_version"] !== CHECK_DECISION_RULE_V2_VERSION) {
    throw new ReceiptNotSelfDerivableError(
      `it does not name decision rule ${CHECK_DECISION_RULE_V2_VERSION}`,
    );
  }
  const candidateDecision = document["candidate_decision"];
  const decision = document["decision"];
  if (!memberOf(CHECK_VERDICTS, candidateDecision)) {
    throw new ReceiptNotSelfDerivableError(
      "candidate decision is not a published verdict",
    );
  }
  if (!memberOf(CHECK_VERDICTS, decision)) {
    throw new ReceiptNotSelfDerivableError(
      "final decision is not a published verdict",
    );
  }
  return {
    receipt_version: CHECK_RECEIPT_V2_VERSION,
    decision_rule_version: CHECK_DECISION_RULE_V2_VERSION,
    checked_at: instant(document["checked_at"], "receipt checked_at").text,
    candidate_decision: candidateDecision,
    decision,
    reason_codes: stringCodes(
      document["reason_codes"],
      CHECK_DECISION_V2_REASON_CODES,
      "decision reason codes",
    ),
    action_classification: parseActionClassification(
      document["action_classification"],
    ),
    policy_binding: parsePolicyBinding(document["policy_binding"]),
    calibration_binding: parseCalibrationBinding(
      document["calibration_binding"],
    ),
    gate: parseAllowGate(document["gate"]),
  };
}

function sameOrderedCodes(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((code, index) => code === right[index])
  );
}

function bindingModeMatches(
  mode: CheckAllowGateMode,
  demoOnly: boolean,
): boolean {
  return mode === "demo" ? demoOnly : !demoOnly;
}

function expectedAllowGate(fields: CheckReceiptV2DecisionFields): {
  status: CheckAllowGateStatus;
  reason_codes: CheckAllowGateReasonCode[];
} {
  if (fields.candidate_decision !== "ALLOW") {
    return { status: "not_applicable", reason_codes: [] };
  }
  if (fields.gate.evaluation_status === "unavailable") {
    return { status: "downgraded", reason_codes: ["ALLOW_GATE_UNAVAILABLE"] };
  }
  const actionClass = fields.action_classification.action_class;
  if (
    fields.action_classification.status !== "classified" ||
    actionClass === null
  ) {
    return {
      status: "downgraded",
      reason_codes: ["ALLOW_ACTION_UNCLASSIFIED"],
    };
  }

  const checkedAt = instant(
    fields.checked_at,
    "receipt checked_at",
  ).nanoseconds;
  const policy = fields.policy_binding;
  const policyIsCurrent =
    policy !== null &&
    policy.action_class === actionClass &&
    bindingModeMatches(fields.gate.mode, policy.demo_only) &&
    instant(policy.valid_from, "policy valid_from").nanoseconds <= checkedAt &&
    (policy.valid_until === null ||
      checkedAt <
        instant(policy.valid_until, "policy valid_until").nanoseconds);
  if (!policyIsCurrent || policy === null) {
    return { status: "downgraded", reason_codes: ["ALLOW_POLICY_UNBOUND"] };
  }

  const calibration = fields.calibration_binding;
  const calibrationIsBound =
    calibration !== null &&
    calibration.action_class === actionClass &&
    calibration.policy_id === policy.id &&
    calibration.policy_version === policy.version &&
    bindingModeMatches(fields.gate.mode, calibration.demo_only) &&
    instant(calibration.evaluated_at, "calibration evaluated_at").nanoseconds <=
      checkedAt;
  if (!calibrationIsBound || calibration === null) {
    return {
      status: "downgraded",
      reason_codes: ["ALLOW_CALIBRATION_UNBOUND"],
    };
  }

  const reasons: CheckAllowGateReasonCode[] = [];
  if (
    calibration.sample_size < policy.minimum_sample_size ||
    calibration.false_allow_upper_bound_bps >
      policy.maximum_false_allow_upper_bound_bps
  ) {
    reasons.push("ALLOW_CALIBRATION_INSUFFICIENT");
  }
  if (
    checkedAt >=
    instant(calibration.expires_at, "calibration expires_at").nanoseconds
  ) {
    reasons.push("ALLOW_CALIBRATION_EXPIRED");
  }
  return reasons.length === 0
    ? { status: "passed", reason_codes: [] }
    : { status: "downgraded", reason_codes: reasons };
}

/**
 * Project a signed receipt back onto `decideCheck`'s inputs — the whole product claim, executable.
 *
 * Feed the result to `decideCheck` and it must reproduce the receipt's own `decision` and
 * `reason_codes` exactly. Nothing else may be consulted: not a database, not the response body, and
 * emphatically not `receipt.reason_codes` itself (reading the answer off the answer would make the
 * round trip vacuous). Anyone holding the JSON can do this with the published decision table.
 *
 * The parameter is `unknown` because a verifier's input is a document someone handed it, not a value
 * a type system already vouched for. Every field the table reads is checked here, and the ONLY
 * permitted outcomes are a complete decision input or a throw.
 *
 * FAILS CLOSED on an under-specified receipt. A document missing the discriminators would re-derive
 * a *more permissive* verdict than was issued — a stale-pending REVIEW would read as ALLOW — so it
 * is refused outright. Silently producing the wrong verdict is the one outcome an auditor cannot
 * detect, which makes it the one outcome this function must never have. The same reasoning covers a
 * value outside a published enum: an unrecognised `materiality` is not "not blocking", it is a
 * document this table cannot answer for.
 */
export function checkDecisionInputFromReceipt(receipt: unknown): {
  facts: CheckDecisionFact[];
  options: CheckDecisionOptions;
} {
  const document = objectOrNull(receipt);
  if (document === null) {
    throw new ReceiptNotSelfDerivableError("it is not a JSON object");
  }
  if (typeof document["compilation_uncertain"] !== "boolean") {
    throw new ReceiptNotSelfDerivableError(
      "it does not state whether compilation was uncertain",
    );
  }
  const factList = document["facts"];
  if (!Array.isArray(factList)) {
    throw new ReceiptNotSelfDerivableError("it does not carry a fact list");
  }
  const ruleVersion = document["decision_rule_version"];
  const facts = factList.map((entry, index) => {
    const fact = objectOrNull(entry);
    if (fact === null)
      throw new ReceiptNotSelfDerivableError(
        `fact ${index} is not a JSON object`,
      );
    if (
      typeof fact["stale_pending"] !== "boolean" ||
      typeof fact["novel"] !== "boolean"
    ) {
      throw new ReceiptNotSelfDerivableError(
        `fact ${index} omits the stale-pending/novel discriminators`,
      );
    }
    // `temporal_state` is what separates FACT_EXPIRED from FACT_CHANGED, so an ABSENT one would
    // silently downgrade the code rather than fail. `null` is a legitimate value (the state was
    // never known); `undefined` is a document that cannot answer the question.
    if (fact["temporal_state"] === undefined) {
      throw new ReceiptNotSelfDerivableError(
        `fact ${index} omits its temporal state`,
      );
    }
    // An unrecognised failure reason must not degrade to "no failure": that is exactly how a
    // SOURCE_UNREACHABLE would quietly re-derive as the milder FACT_UNKNOWN.
    const freshnessFailure = fact["freshness_failure"];
    if (
      freshnessFailure !== null &&
      !memberOf(CHECK_FRESHNESS_FAILURES, freshnessFailure)
    ) {
      throw new ReceiptNotSelfDerivableError(
        `fact ${index} carries a freshness failure this contract does not define`,
      );
    }
    // The two inputs rows 1-4 branch on. A `materiality` or `state` this table does not define
    // would fall through every row into the permissive direction, so it is refused instead.
    const materiality = fact["materiality"];
    if (!memberOf(CHECK_MATERIALITIES, materiality)) {
      throw new ReceiptNotSelfDerivableError(
        `fact ${index} carries a materiality this contract does not define`,
      );
    }
    const state = fact["state"];
    if (!memberOf(CHECK_FACT_STATES, state)) {
      throw new ReceiptNotSelfDerivableError(
        `fact ${index} carries a state this contract does not define`,
      );
    }
    const method = fact["method"];
    if (!memberOf(CHECK_FACT_METHODS, method)) {
      throw new ReceiptNotSelfDerivableError(
        `fact ${index} carries a method this contract does not define`,
      );
    }
    const temporalState = fact["temporal_state"];
    if (temporalState !== null && typeof temporalState !== "string") {
      throw new ReceiptNotSelfDerivableError(
        `fact ${index} carries a non-textual temporal state`,
      );
    }
    // Older receipts did not publish semantic roles. They remain derivable as non-contested.
    const basis = Array.isArray(fact["basis"]) ? fact["basis"] : [];
    const contested = basis.some(
      (entry) => objectOrNull(entry)?.["role"] === "contesting",
    );
    return {
      materiality,
      status: state,
      method,
      temporalState,
      stalePending: fact["stale_pending"],
      novel: fact["novel"],
      ...(contested ? { contested: true } : {}),
      ...(freshnessFailure === null ? {} : { freshnessFailure }),
    } satisfies CheckDecisionFact;
  });
  if (!memberOf(CHECK_DECISION_RULE_VERSIONS, ruleVersion)) {
    throw new ReceiptNotSelfDerivableError(
      typeof ruleVersion === "string"
        ? `it names unsupported decision rule ${ruleVersion}`
        : "it names no decision rule version",
    );
  }
  return {
    facts,
    options: {
      compilationUncertain: document["compilation_uncertain"],
      ruleVersion,
    },
  };
}

/**
 * The one-call form: hand it a receipt, get back the verdict its own facts imply.
 *
 * This never reads `receipt.decision` or `receipt.reason_codes`. Comparing the answer to those two
 * fields is the caller's job — and is what `verifyReceipt(..., { derive_verdict: true })` does.
 */
/** Derive and validate every rule-2 decision field from one signed receipt. */
export function deriveCheckDecisionV2(receipt: unknown): CheckDecisionV2 {
  const fields = parseCheckReceiptV2DecisionFields(receipt);
  const { facts, options } = checkDecisionInputFromReceipt(receipt);
  const candidate = decideCheck(facts, options);
  if (candidate.verdict !== fields.candidate_decision) {
    throw new ReceiptNotSelfDerivableError(
      `it states candidate ${fields.candidate_decision} but its facts derive ${candidate.verdict}`,
    );
  }

  const gate = expectedAllowGate(fields);
  if (
    fields.gate.status !== gate.status ||
    !sameOrderedCodes(fields.gate.reason_codes, gate.reason_codes)
  ) {
    throw new ReceiptNotSelfDerivableError(
      `it states gate ${fields.gate.status} [${fields.gate.reason_codes.join(", ")}] but its signed gate inputs derive ${gate.status} [${gate.reason_codes.join(", ")}]`,
    );
  }

  const verdict: CheckVerdict =
    gate.status === "downgraded" ? "REVIEW" : candidate.verdict;
  const reasonCodes: CheckDecisionV2ReasonCode[] =
    gate.status === "downgraded" ? gate.reason_codes : candidate.reason_codes;
  if (fields.decision !== verdict) {
    throw new ReceiptNotSelfDerivableError(
      `it states final decision ${fields.decision} but rule 2 derives ${verdict}`,
    );
  }
  if (!sameOrderedCodes(fields.reason_codes, reasonCodes)) {
    throw new ReceiptNotSelfDerivableError(
      `it states reason codes [${fields.reason_codes.join(", ")}] but rule 2 derives [${reasonCodes.join(", ")}]`,
    );
  }

  return {
    verdict,
    reason_codes: reasonCodes,
    decision_rule_version: CHECK_DECISION_RULE_V2_VERSION,
    candidate_decision: candidate.verdict,
    candidate_reason_codes: candidate.reason_codes,
    gate,
  };
}

export function deriveCheckDecision(receipt: unknown): DerivedCheckDecision {
  const document = objectOrNull(receipt);
  if (document?.["decision_rule_version"] === CHECK_DECISION_RULE_V2_VERSION) {
    return deriveCheckDecisionV2(receipt);
  }
  const { facts, options } = checkDecisionInputFromReceipt(receipt);
  return decideCheck(facts, options);
}

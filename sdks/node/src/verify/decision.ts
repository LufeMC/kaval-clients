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
export const CHECK_DECISION_RULE_VERSIONS = [
  "check-decision/1.0.0",
  CHECK_DECISION_RULE_VERSION,
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
export function deriveCheckDecision(receipt: unknown): CheckDecision {
  const { facts, options } = checkDecisionInputFromReceipt(receipt);
  return decideCheck(facts, options);
}

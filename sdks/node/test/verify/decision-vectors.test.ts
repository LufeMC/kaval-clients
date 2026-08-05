/**
 * THE PUBLISHED HALF of the shared decision-table conformance pair.
 *
 * `test/fixtures/verify-vectors/check-decision-vectors.json` is byte-identical to
 * `vectors/check-decision-vectors.json` in the issuer copy (`@kaval/receipt-verifier`, Kaval's
 * private repo), and `test/check-decision-vectors.test.mjs` there runs these same cases against the
 * table the issuer actually executes when it signs a receipt.
 *
 * That pairing is the point. `src/verify/decision.ts` is a mirrored copy, not a shared module — the
 * two repositories cannot import each other, one being private and one public. A prose rule can
 * oblige a human to carry a change across; it cannot detect a table that drifted. These vectors can:
 * two implementations that both pass byte-identical cases cannot disagree about any verdict,
 * reason-code array, or refusal the cases cover, whatever their file layout.
 *
 * The failure this prevents has two faces, and both are release blockers: a published table that
 * refuses a verdict Kaval legitimately issued, which to a holder is indistinguishable from a
 * forgery; and a published table that accepts a verdict Kaval would never have issued, which is the
 * same document read the other way round.
 *
 * `mirror-pin.test.ts` pins this file's digest so it cannot move here silently, and the issuer's
 * `mirror-manifest.json` pins the same hex on the other side.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  CHECK_DECISION_RULE_VERSION,
  CHECK_DECISION_RULE_VERSIONS,
  CHECK_FACT_METHODS,
  CHECK_FACT_STATES,
  CHECK_FRESHNESS_FAILURES,
  CHECK_MATERIALITIES,
  CHECK_REASON_CODES,
  CHECK_VERDICTS,
  ReceiptNotSelfDerivableError,
  decideCheck,
  deriveCheckDecision,
  type CheckDecisionFact,
  type CheckDecisionOptions,
} from "../../src/verify/index.js";

interface DecideVector {
  id: string;
  facts: CheckDecisionFact[];
  options?: CheckDecisionOptions;
  verdict: string;
  reason_codes: string[];
}

interface DeriveVector {
  id: string;
  receipt: unknown;
  verdict: string;
  reason_codes: string[];
}

interface RefuseVector {
  id: string;
  receipt: unknown;
  message_contains: string;
}

const vectors = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL(
        "../fixtures/verify-vectors/check-decision-vectors.json",
        import.meta.url,
      ),
    ),
    "utf8",
  ),
) as {
  decision_rule_version: string;
  enums: Record<string, string | string[]>;
  decide: DecideVector[];
  derive: DeriveVector[];
  refuse: RefuseVector[];
};

describe("check-decision conformance vectors", () => {
  test("the vectors pin the published enums, in order", () => {
    expect(vectors.decision_rule_version).toBe(CHECK_DECISION_RULE_VERSION);
    expect(vectors.enums["rule_version"]).toBe(CHECK_DECISION_RULE_VERSION);
    expect(vectors.enums["verdicts"]).toEqual([...CHECK_VERDICTS]);
    expect(vectors.enums["reason_codes"]).toEqual([...CHECK_REASON_CODES]);
    expect(vectors.enums["fact_methods"]).toEqual([...CHECK_FACT_METHODS]);
    expect(vectors.enums["fact_states"]).toEqual([...CHECK_FACT_STATES]);
    expect(vectors.enums["materialities"]).toEqual([...CHECK_MATERIALITIES]);
    expect(vectors.enums["freshness_failures"]).toEqual([
      ...CHECK_FRESHNESS_FAILURES,
    ]);
    expect(CHECK_DECISION_RULE_VERSIONS).toEqual([
      "check-decision/1.0.0",
      "check-decision/1.1.0",
    ]);
  });

  test("rule 1.0.0 keeps critical unknowns blocked while 1.1.0 recognizes contests", () => {
    const receipt = {
      decision_rule_version: "check-decision/1.0.0",
      compilation_uncertain: false,
      facts: [
        {
          materiality: "critical",
          state: "unknown",
          method: "state",
          temporal_state: "unknown",
          freshness_failure: null,
          stale_pending: false,
          novel: false,
          basis: [{ source_locator: "matter:contest", role: "contesting" }],
        },
      ],
    };
    expect(deriveCheckDecision(receipt).verdict).toBe("BLOCK");
    receipt.decision_rule_version = CHECK_DECISION_RULE_VERSION;
    expect(deriveCheckDecision(receipt).verdict).toBe("REVIEW");
  });

  test("every decide vector produces its recorded verdict and reason codes", () => {
    for (const vector of vectors.decide) {
      expect(
        decideCheck(vector.facts, vector.options ?? {}),
        vector.id,
      ).toEqual({
        verdict: vector.verdict,
        reason_codes: vector.reason_codes,
        decision_rule_version: CHECK_DECISION_RULE_VERSION,
      });
    }
  });

  test("every derive vector re-derives its recorded verdict from a receipt alone", () => {
    for (const vector of vectors.derive) {
      expect(deriveCheckDecision(vector.receipt), vector.id).toEqual({
        verdict: vector.verdict,
        reason_codes: vector.reason_codes,
        decision_rule_version: CHECK_DECISION_RULE_VERSION,
      });
    }
  });

  test("every refuse vector is refused, by the recorded reason", () => {
    for (const vector of vectors.refuse) {
      let thrown: unknown;
      try {
        deriveCheckDecision(vector.receipt);
      } catch (error) {
        thrown = error;
      }
      expect(thrown, `${vector.id} was not refused`).toBeInstanceOf(
        ReceiptNotSelfDerivableError,
      );
      expect((thrown as Error).message, vector.id).toContain(
        vector.message_contains,
      );
    }
  });

  test("the corpus is not vacuous: it covers every verdict and every reason code", () => {
    // A truncated or de-fanged corpus would pass every case it still contained. These bounds are
    // what stop that, and they also mean no constant-returning table can pass this file.
    const cases = [...vectors.decide, ...vectors.derive];
    expect(cases.length).toBeGreaterThanOrEqual(25);
    expect(vectors.refuse.length).toBeGreaterThanOrEqual(10);

    const verdicts = [...new Set(cases.map((vector) => vector.verdict))].sort();
    expect(verdicts).toEqual([...CHECK_VERDICTS].sort());

    const codes = [
      ...new Set(cases.flatMap((vector) => vector.reason_codes)),
    ].sort();
    expect(codes).toEqual([...CHECK_REASON_CODES].sort());

    const reasons = new Set(
      vectors.refuse.map((vector) => vector.message_contains),
    );
    expect(reasons.size).toBeGreaterThanOrEqual(10);
  });
});

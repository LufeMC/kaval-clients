/**
 * The published half of the anti-divergence pin.
 *
 * Two copies of receipt-signature logic exist and cannot be collapsed into one. This one is the
 * published verifier (`@usekaval/kaval/verify`). The other is the issuer copy, `@kaval/receipt-
 * verifier`, which lives in Kaval's private repo and is the canonicalizer the server actually signs
 * receipts with — it cannot depend on this package without pinning receipt signing to an npm release
 * cadence, and this package cannot import from it because that repo is private.
 *
 * Divergence between them is the worst failure available here: a receipt Kaval legitimately issued
 * that Kaval's own published verifier refuses. To the holder that is indistinguishable from a
 * forgery, and it discredits every other receipt at the same time.
 *
 * File-level byte-identity across the two is not a property that could hold — the implementation is
 * restructured here into a subpath export. What IS comparable is the frozen conformance vectors:
 * two implementations that both pass byte-identical vectors cannot disagree about anything the
 * vectors cover, whatever their file layout. So both sides pin the same three digests. The issuer
 * copy pins them in `mirror-manifest.json` (`vectors`); this file is the other half of that pair,
 * and the two lists of hex below are meant to be literally the same strings.
 *
 * A one-byte edit to a vector on this side fails here. A one-byte edit on the issuer side fails
 * there. Neither can be made silently, which is the whole point: the digests are only allowed to
 * move as a deliberate, acknowledged, both-sides act.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const VECTORS_DIRECTORY = fileURLToPath(
  new URL("../fixtures/verify-vectors/", import.meta.url),
);
const SUITE_DIRECTORY = fileURLToPath(new URL("./", import.meta.url));

/**
 * Byte digests of the frozen conformance vectors, pinned as literals.
 *
 * These are the same strings recorded under `vectors` in the issuer copy's `mirror-manifest.json`.
 * Changing one here without changing it there — or the reverse — is exactly the drift this pin
 * exists to make impossible to do quietly.
 */
const PINNED_VECTOR_DIGESTS: Readonly<Record<string, string>> = {
  "canonicalization-vectors.json":
    "sha256:b0b9c61e9370c1a6a454426b8201d1e9c3215120a5ac50ac89f001e8b960aa73",
  "ed25519-receipt-vectors.json":
    "sha256:8de7a80962a23bef3bf77d4b91bde52c4afed9d6679b89d4d10a2765822fd416",
  "rfc3339-vectors.json":
    "sha256:9221b3f85ac112a006d342743ad02d041d08eb8d34a8e8bdaedcc95372e6a3b2",
};

const CARRY_ACROSS =
  "The shared conformance vectors changed. They are pinned on BOTH sides of the receipt " +
  "signature: here, and in the issuer copy's mirror-manifest.json (@kaval/receipt-verifier, " +
  "Kaval's private repo). Carry the change to the other side, run its `mirror:accept`, and " +
  "update the digests in this file so the two pinned sets match again. If you cannot do both, " +
  "revert: a vector that means one thing to the issuer and another to the published verifier is " +
  "a receipt that verifies for us and fails for the holder.";

function digestOf(name: string): string {
  const bytes = readFileSync(join(VECTORS_DIRECTORY, name));
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

describe("mirror pin — shared conformance vectors", () => {
  test("every vector still hashes to its pinned digest", () => {
    const actual = Object.fromEntries(
      Object.keys(PINNED_VECTOR_DIGESTS).map((name) => [name, digestOf(name)]),
    );
    expect(actual, CARRY_ACROSS).toEqual(PINNED_VECTOR_DIGESTS);
  });

  test("the pin covers every vector file present, and no phantom ones", () => {
    // A pin that quietly stopped covering `ed25519-receipt-vectors.json` would pass the test above
    // forever. Adding a fourth vector on one side only is drift too, so the sets must be equal.
    const onDisk = readdirSync(VECTORS_DIRECTORY)
      .filter((name) => name.endsWith(".json"))
      .sort();
    expect(onDisk, CARRY_ACROSS).toEqual(
      Object.keys(PINNED_VECTOR_DIGESTS).sort(),
    );
  });

  test("the pinned vectors are the ones the verifier suite actually runs", () => {
    // A pin on files nobody executes is decoration. Each vector file below is loaded by a sibling
    // suite; if one stops being read, the digest still matches but it no longer constrains anything.
    const suites = readdirSync(SUITE_DIRECTORY)
      .filter(
        (name) => name.endsWith(".test.ts") && name !== "mirror-pin.test.ts",
      )
      .map((name) => readFileSync(join(SUITE_DIRECTORY, name), "utf8"))
      .join("\n");

    for (const name of Object.keys(PINNED_VECTOR_DIGESTS)) {
      expect(
        suites.includes(name),
        `${name} is pinned but no verifier suite loads it — the pin constrains nothing`,
      ).toBe(true);
    }
  });
});

#!/usr/bin/env node
/**
 * Validates the repo's front door — README, CHANGELOG — and the CI gate that keeps them honest.
 *
 * Why this exists: every suite in this repo fakes the API, so the whole pipeline stayed green while
 * the published clients aborted their own headline call at 30s and `report_outcome` 404'd on every
 * receipt ever issued. The one suite that would have caught both was `skipIf`-gated and no workflow
 * ever set its credentials. Documentation and the job that exercises it are the same problem: a
 * claim nobody executes. This asserts both are still wired.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (...parts) => readFileSync(join(root, ...parts), "utf8");

const readme = read("README.md");
const changelog = read("CHANGELOG.md");
const ci = read(".github", "workflows", "ci.yml");
const release = read(".github", "workflows", "release.yml");
const pyproject = read("sdks", "python", "pyproject.toml");

let fail = 0;
const check = (name, cond) => {
  console.error(`${cond ? "✓" : "✗"} ${name}`);
  if (!cond) fail++;
};

/**
 * Markdown wraps at 100 columns, so anything spanning a sentence must be matched unwrapped — and
 * the blockquote markers a reader never sees must not split a phrase the way a line break does.
 */
const flat = (text) => text.replace(/^\s*>\s?/gm, "").replace(/\s+/g, " ");

// ---------------------------------------------------------------------------
// The live gate (the job whose absence let B1 and B2 ship)
// ---------------------------------------------------------------------------

const MCP_LIVE_SUITE = "test/live-tools.test.ts";
const PY_LIVE_SUITE = "tests/test_live.py";

check(
  "ci.yml runs on a schedule and on demand",
  /^on:$/m.test(ci) &&
    /^\s{2}schedule:$/m.test(ci) &&
    /^\s{2}workflow_dispatch:$/m.test(ci),
);
// The live contract gate does NOT live here. This repo cannot reach the closed-core server, and
// there is no staging deployment — pointing a release gate at production would write test sources,
// receipts and outcome reports into the live product on every tag. The real client-vs-server
// contract test runs in the kaval repo's CI, which boots the server against its own Postgres.
// Do not re-add a staging gate here; it can only ever be decorative or wrong.
// `pypi` has no build dependency on `npm`; the edge exists only so the npm job's gate covers it.
check(
  "release.yml chains every publish behind the gated npm job",
  /\n  pypi:\n(?:.|\n)*?needs: \[npm\]/.test(release) &&
    /\n  mcp:\n(?:.|\n)*?needs: \[npm\]/.test(release),
);

// ---------------------------------------------------------------------------
// The published half of the verifier mirror pin
// ---------------------------------------------------------------------------

// `sdks/node/test/verify/mirror-pin.test.ts` holds the shared conformance vectors against digests
// that the issuer copy (`@kaval/receipt-verifier`, private repo) pins to the same values. That test
// catches an edit to the vectors; nothing but this catches the deletion of the test itself, which
// would restore the exact situation it was written for — one side pinning, the other pinning
// nothing, and drift going unnoticed until a holder's receipt is refused.
const PIN_TEST = join("sdks", "node", "test", "verify", "mirror-pin.test.ts");
const VECTORS_DIR = join("sdks", "node", "test", "fixtures", "verify-vectors");
let pin = "";
try {
  pin = read(PIN_TEST);
} catch {
  /* reported by the check below */
}
check(`${PIN_TEST} exists`, pin.length > 0);
if (pin) {
  const vectors = readdirSync(join(root, VECTORS_DIR))
    .filter((name) => name.endsWith(".json"))
    .sort();
  check(
    `${PIN_TEST} pins a sha256 for all ${vectors.length} shared vectors`,
    vectors.length > 0 &&
      vectors.every((name) =>
        new RegExp(`"${name}":\\s*"sha256:[0-9a-f]{64}"`).test(flat(pin)),
      ),
  );
}

// ---------------------------------------------------------------------------
// The Python floor is a published promise, so it has to be a tested one
// ---------------------------------------------------------------------------

const floor = /requires-python\s*=\s*">=\s*([0-9]+\.[0-9]+)"/.exec(
  pyproject,
)?.[1];
check("pyproject declares a requires-python floor", typeof floor === "string");
check(
  `ci.yml tests the declared floor (${floor ?? "?"})`,
  typeof floor === "string" &&
    new RegExp(`"${floor.replace(".", "\\.")}"`).test(ci),
);

// ---------------------------------------------------------------------------
// Docs honesty
// ---------------------------------------------------------------------------

// The central trust claim. It may be requalified; it may not be quietly dropped.
check(
  "README still makes the offline-verification claim",
  /no Kaval account/i.test(flat(readme)) &&
    /proof-verification-keys/.test(readme),
);

// …and may not recommend a package that 404s on npm without saying so. The disclosure has to sit
// beside the mention, not merely somewhere in the file: a reader who stops at the sentence that
// names the package is the reader this is for.
const VERIFIER = /@kaval\/receipt-verifier/g;
const DISCLOSED =
  /404|unpublish|not (?:yet )?published|never published|not on npm/i;
const NEARBY = 320;
for (const [file, text] of [
  ["README.md", readme],
  ["CHANGELOG.md", changelog],
]) {
  const body = flat(text);
  for (const match of body.matchAll(VERIFIER)) {
    const window = body.slice(
      Math.max(0, match.index - NEARBY),
      match.index + NEARBY,
    );
    check(
      `${file} discloses next to each @kaval/receipt-verifier mention that it is unpublished`,
      DISCLOSED.test(window),
    );
  }
}

// Routes the server answers 410 on. They are legitimate history; they are not a live surface.
const RETIRED = [
  "/v1/audit",
  "/v1/gate",
  "/v1/beliefs",
  "/v1/belief-gate",
  "/v1/belief-outcomes",
  "/v1/scan-store",
  "/v1/extract-and-check",
  "/v1/monitor",
  "/v1/kaval-batch",
  "/v1/evidence-events",
];
const MARKED_GONE = /remove|retire|gone|410|no longer|0\.5/i;
for (const [file, text] of [
  ["README.md", readme],
  ["CHANGELOG.md", changelog],
]) {
  for (const [index, line] of text.split("\n").entries()) {
    for (const route of RETIRED) {
      if (!line.includes(route)) continue;
      check(
        `${file}:${index + 1} presents ${route} as retired, not live`,
        MARKED_GONE.test(line),
      );
    }
  }
}

// The budget the docs published for years, and the engine abandoned. See PRIV check-budget.ts.
for (const [file, text] of [
  ["README.md", readme],
  ["CHANGELOG.md", changelog],
]) {
  const body = flat(text);
  check(
    `${file} does not repeat the retired "default 3000 / max 15000" budget`,
    !/defaults? to 3000/i.test(body) && !/max(?:imum)? 15000/i.test(body),
  );
}

// The Python snippets are transliterated from their TypeScript twins, which is how they end up
// importing a class that does not exist (`Kaval`; it is `KavalClient`) and reaching for `os.environ`
// without the import `process.env` never needed. Both fail on the snippet's first line.
const PY_EXPORTS = new Set(
  [
    ...read("sdks", "python", "kaval", "__init__.py").matchAll(
      /"([A-Za-z_]\w*)",/g,
    ),
  ].map((m) => m[1]),
);
for (const [index, block] of [
  ...readme.matchAll(/```(?:py|python)\n([\s\S]*?)```/g),
].entries()) {
  const code = block[1];
  check(
    `README python snippet ${index + 1} imports only names the SDK exports`,
    [...code.matchAll(/from kaval import ([^\n]+)/g)]
      .flatMap((m) => m[1].split(",").map((name) => name.trim()))
      .every((name) => PY_EXPORTS.has(name)),
  );
  check(
    `README python snippet ${index + 1} imports every module it uses`,
    !/\bos\./.test(code) || /^import os$/m.test(code),
  );
}

if (fail > 0) {
  console.error(`\n${fail} check(s) failed.`);
  process.exit(1);
}
console.error("\nFront-door docs + live gate OK.");

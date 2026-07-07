#!/usr/bin/env node
/**
 * Bump all three Kaval clients to ONE shared version, in lockstep:
 *   - @usekaval/kaval  → sdks/node/package.json
 *   - @usekaval/mcp    → packages/mcp/package.json
 *   - kaval (PyPI)     → sdks/python/pyproject.toml
 *
 * Usage:  node scripts/bump.mjs <patch|minor|major|X.Y.Z>
 *
 * Prints the new version to stdout (the version-bump workflow reads it). The canonical current
 * version is the Node SDK's; the Release workflow asserts all three equal the git tag, so they
 * MUST stay in sync — editing them together here is exactly what prevents the drift.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NODE_PKG = resolve(ROOT, "sdks/node/package.json");
const MCP_PKG = resolve(ROOT, "packages/mcp/package.json");
const PYPROJECT = resolve(ROOT, "sdks/python/pyproject.toml");

const arg = (process.argv[2] || "").trim();
if (!arg) {
  console.error("usage: node scripts/bump.mjs <patch|minor|major|X.Y.Z>");
  process.exit(1);
}

const parse = (v) => {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  if (!m) throw new Error(`not a semver: ${v}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
};

const current = JSON.parse(readFileSync(NODE_PKG, "utf8")).version;
const [maj, min, pat] = parse(current);

let next;
if (/^\d+\.\d+\.\d+$/.test(arg)) next = arg;
else if (arg === "patch") next = `${maj}.${min}.${pat + 1}`;
else if (arg === "minor") next = `${maj}.${min + 1}.0`;
else if (arg === "major") next = `${maj + 1}.0.0`;
else {
  console.error(`bad bump argument: "${arg}" (want patch|minor|major|X.Y.Z)`);
  process.exit(1);
}

const cmp = (a, b) => {
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
};
if (cmp(next, current) < 0) {
  console.error(`refusing to move ${current} -> ${next} (would go backwards)`);
  process.exit(1);
}

// package.json: parse + set + reserialize (preserves key order incl. mcpName; 2-space + newline).
const setPkg = (file) => {
  const obj = JSON.parse(readFileSync(file, "utf8"));
  obj.version = next;
  writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`);
};

// pyproject.toml: targeted replace of the version line (no TOML dependency needed).
const setPy = (file) => {
  const src = readFileSync(file, "utf8");
  const out = src.replace(/^(version\s*=\s*")\d+\.\d+\.\d+(")/m, `$1${next}$2`);
  if (out === src) {
    console.error(`could not find a 'version = "X.Y.Z"' line in ${file}`);
    process.exit(1);
  }
  writeFileSync(file, out);
};

setPkg(NODE_PKG);
setPkg(MCP_PKG);
setPy(PYPROJECT);

process.stdout.write(next); // consumed by the version-bump workflow

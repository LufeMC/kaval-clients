#!/usr/bin/env node
// Proves the THREE PUBLISHED surfaces work against a real Kaval server.
//
// Not a unit test and deliberately not hermetic: it installs @usekaval/kaval, @usekaval/mcp and
// the `kaval` wheel FROM THE REGISTRIES into a throwaway directory, then drives each one at a live
// API. The repo's own suites are hermetic — their fixtures were hand-written to agree with the SDK
// rather than recorded from a server, which is exactly how a `report_outcome` that 404s for every
// receipt ever issued stayed green for months. This is the check that would have caught it.
//
//   KAVAL_API_KEY=kv_live_... node scripts/verify-published.mjs [--base-url https://api.usekaval.com]
//
// Exit 0 = every surface works. Exit 1 = at least one is broken, and it says which.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : argv[i + 1];
};
const BASE = arg("--base-url", process.env.KAVAL_BASE_URL ?? "https://api.usekaval.com");
const KEY = process.env.KAVAL_API_KEY;
if (!KEY) {
  console.error("KAVAL_API_KEY is required — an ISSUED kv_live_ key, not the demo key.");
  console.error("A demo or static key authenticates but carries no principal, so every durable");
  console.error("route answers 403 *_owner_required and this would fail for the wrong reason.");
  process.exit(2);
}

const C = { g: "[32m", r: "[31m", d: "[2m", b: "[1m", x: "[0m" };
const results = [];
const record = (surface, name, ok, detail) => {
  results.push({ surface, name, ok, detail });
  const mark = ok ? `${C.g}PASS${C.x}` : `${C.r}FAIL${C.x}`;
  console.log(`  ${mark}  ${String(name).padEnd(46)} ${C.d}${detail ?? ""}${C.x}`);
};
const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });

const work = mkdtempSync(join(tmpdir(), "kaval-verify-"));
let exitCode = 0;

try {
  console.log(`\n  ${C.b}Verifying the PUBLISHED clients against ${BASE}${C.x}\n`);

  /* ---------------------------------- install ---------------------------------- */
  writeFileSync(join(work, "package.json"), JSON.stringify({ name: "v", private: true, type: "module" }));
  run("npm", ["install", "--silent", "--no-audit", "--no-fund", "@usekaval/kaval@latest", "@usekaval/mcp@latest"], { cwd: work });
  // Read from disk, not through the exports map: a package is under no obligation to export
  // ./package.json, and @usekaval/mcp does not.
  const installed = (name) =>
    JSON.parse(readFileSync(join(work, "node_modules", name, "package.json"), "utf8")).version;
  const nodeVer = installed("@usekaval/kaval");
  const mcpVer = installed("@usekaval/mcp");
  console.log(`  ${C.d}installed @usekaval/kaval@${nodeVer}, @usekaval/mcp@${mcpVer}${C.x}\n`);

  /* -------------------------------- 1. NODE SDK -------------------------------- */
  console.log(`  ${C.b}Node SDK${C.x}`);
  const driver = join(work, "drive.mjs");
  writeFileSync(
    driver,
    `
import { Kaval } from "@usekaval/kaval";
import { verifyReceipt } from "@usekaval/kaval/verify";
const k = new Kaval({ apiKey: process.env.KAVAL_API_KEY, baseUrl: ${JSON.stringify(BASE)} });
const out = {};
out.health = await k.health();
out.timeoutDefault = new Kaval({ apiKey: "x" }).timeoutMs ?? "unset";
const chk = await k.check({ action: "Publish verification probe — confirm the released client reaches this server" });
out.check = { decision: chk.decision, receiptId: chk.receipt?.id, facts: chk.facts?.length ?? 0 };
if (chk.receipt?.id) {
  const r = await k.getReceipt(chk.receipt.id);
  out.receipt = { id: r.id, decision: r.decision, basisKeys: Object.keys(r.facts?.[0]?.basis?.[0] ?? {}) };
  out.reportOutcome = await k.reportOutcome({ id: chk.receipt.id, kind: "current_later_contradicted", note: "published-client verification probe" }).then(() => "recorded").catch((e) => "ERR " + (e.status ?? "") + " " + JSON.stringify(e.payload ?? e.message).slice(0, 120));
}
out.verifyExport = typeof verifyReceipt;
out.recompileExport = typeof k.recompileSource;
console.log(JSON.stringify(out));
`,
  );
  let node;
  try {
    node = JSON.parse(run("node", [driver], { cwd: work, env: { ...process.env, KAVAL_API_KEY: KEY } }).trim().split("\n").pop());
  } catch (e) {
    node = null;
    record("node", "driver ran", false, String(e.stderr ?? e.message).slice(0, 200));
    exitCode = 1;
  }
  if (node) {
    record("node", "health()", node.health?.ok === true, `version ${node.health?.version?.slice(0, 12) ?? "?"}`);
    record("node", "check() reaches the server", ["ALLOW", "REVIEW", "BLOCK"].includes(node.check?.decision), `${node.check?.decision} · ${node.check?.facts} facts`);
    record("node", "default timeout survives a cold check", node.timeoutDefault >= 100000, `${node.timeoutDefault}ms (server budget 100000ms)`);
    record("node", "getReceipt() returns the signed doc", !!node.receipt?.id, node.receipt?.id ?? "no receipt");
    const bk = node.receipt?.basisKeys ?? [];
    record("node", "receipt basis labels its digest", bk.length === 0 || bk.includes("version_sha256_of"), bk.length === 0 ? "no basis on this verdict — nothing to label" : bk.join(","));
    record("node", "reportOutcome() (404'd for every receipt before)", node.reportOutcome === "recorded", node.reportOutcome ?? "not attempted");
    record("node", "@usekaval/kaval/verify subpath exports", node.verifyExport === "function", `verifyReceipt is ${node.verifyExport}`);
    record("node", "recompileSource() exists", node.recompileExport === "function", `${node.recompileExport}`);
  }

  /* ---------------------------------- 2. MCP ----------------------------------- */
  console.log(`\n  ${C.b}MCP server${C.x}`);
  const mcpDriver = join(work, "mcp.mjs");
  writeFileSync(
    mcpDriver,
    `
import { spawn } from "node:child_process";
const bin = "./node_modules/@usekaval/mcp/dist/bin.js";
const p = spawn(process.execPath, [bin], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, KAVAL_BASE_URL: ${JSON.stringify(BASE)} } });
let buf = "";
p.stdout.on("data", (d) => (buf += d));
const send = (m) => p.stdin.write(JSON.stringify(m) + "\\n");
send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "verify", version: "1" } } });
send({ jsonrpc: "2.0", method: "notifications/initialized" });
send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
setTimeout(() => {
  const msgs = buf.split("\\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const tools = msgs.find((m) => m.id === 2)?.result?.tools ?? [];
  console.log(JSON.stringify({ tools: tools.map((t) => t.name), maxWait: tools.find((t) => t.name === "check")?.inputSchema?.properties?.max_wait_ms }));
  p.kill();
}, 6000);
`,
  );
  let mcp;
  try {
    mcp = JSON.parse(run("node", [mcpDriver], { cwd: work, env: { ...process.env, KAVAL_API_KEY: KEY } }).trim().split("\n").pop());
  } catch (e) {
    mcp = null;
    record("mcp", "server starts and lists tools", false, String(e.stderr ?? e.message).slice(0, 200));
    exitCode = 1;
  }
  if (mcp) {
    const want = ["check", "verify", "add_source", "list_sources", "report_outcome", "get_receipt", "remove_source"];
    const missing = want.filter((t) => !mcp.tools.includes(t));
    record("mcp", "exposes the full tool surface", missing.length === 0, missing.length ? `missing ${missing.join(",")}` : mcp.tools.join(","));
    record("mcp", "get_receipt is reachable by an agent", mcp.tools.includes("get_receipt"), "was absent before 0.6.0");
    const mx = mcp.maxWait?.maximum;
    record("mcp", "max_wait_ms ceiling is not 15000", mx === undefined || mx > 15000, `maximum=${mx ?? "unbounded"}`);
  }

  /* -------------------------------- 3. PYTHON ---------------------------------- */
  console.log(`\n  ${C.b}Python SDK${C.x}`);
  const venv = join(work, "venv");
  let py = null;
  try {
    run("python3", ["-m", "venv", venv]);
    py = join(venv, "bin", "python");
    run(py, ["-m", "pip", "install", "-q", "--disable-pip-version-check", "kaval"]);
    const pyDriver = join(work, "drive.py");
    writeFileSync(
      pyDriver,
      `import json, os, kaval
from kaval import KavalClient
c = KavalClient(api_key=os.environ["KAVAL_API_KEY"], base_url=${JSON.stringify(BASE)})
out = {"version": getattr(kaval, "__version__", "?"), "exports_Kaval": "Kaval" in kaval.__all__}
out["health"] = c.health()
r = c.check(action="Publish verification probe — confirm the released python client reaches this server")
out["check"] = {"decision": r["decision"], "facts": len(r.get("facts") or [])}
out["timeout_default"] = KavalClient(api_key="x")._timeout if hasattr(KavalClient(api_key="x"), "_timeout") else None
out["has_recompile"] = hasattr(c, "recompile_source")
try:
    c.verify("a bare string")
    out["verify_guard"] = "NO GUARD — accepted a string"
except TypeError as e:
    out["verify_guard"] = "TypeError (correct)"
except AttributeError as e:
    out["verify_guard"] = "AttributeError (BUG)"
except Exception as e:
    out["verify_guard"] = type(e).__name__
print(json.dumps(out))
`,
    );
    const pyOut = JSON.parse(run(py, [pyDriver], { cwd: work, env: { ...process.env, KAVAL_API_KEY: KEY } }).trim().split("\n").pop());
    record("python", "installs from PyPI and imports", true, `kaval ${pyOut.version}`);
    record("python", "health()", pyOut.health?.ok === true, "");
    record("python", "check() reaches the server", ["ALLOW", "REVIEW", "BLOCK"].includes(pyOut.check?.decision), `${pyOut.check?.decision} · ${pyOut.check?.facts} facts`);
    record("python", "recompile_source() exists", pyOut.has_recompile === true, "");
    record("python", "verify('string') raises cleanly", /TypeError|ValueError/.test(pyOut.verify_guard ?? ""), `${pyOut.verify_guard} (AttributeError would be the bug)`);
    record("python", "does NOT export a bogus `Kaval` name", pyOut.exports_Kaval === false, "docs must say KavalClient");
  } catch (e) {
    record("python", "installs from PyPI and drives the API", false, String(e.stderr ?? e.message).slice(0, 240));
    exitCode = 1;
  }

  /* --------------------------------- summary ----------------------------------- */
  const failed = results.filter((r) => !r.ok);
  console.log(`\n  ${failed.length === 0 ? C.g : C.r}${results.length - failed.length}/${results.length} checks passed${C.x}`);
  if (failed.length) {
    exitCode = 1;
    for (const f of failed) console.log(`    ${C.r}·${C.x} [${f.surface}] ${f.name} — ${f.detail}`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
process.exit(exitCode);

/**
 * The property `@usekaval/kaval/verify` exists to guarantee.
 *
 * The verifier's whole value is that a receipt holder can check a signature without talking to
 * Kaval — or to anyone. That is a claim about the *import graph*, not about intent: one careless
 * `export * from "./discovery.js"`, or repointing the subpath at the client's root entry, and the
 * "offline verifier" quietly acquires a network dependency while every other test still passes.
 *
 * So this walks the real module graph from the entry point — sources and the compiled `dist`
 * artifact npm ships — using the TypeScript parser rather than a text search, so a token inside a
 * comment or a string cannot fake either a pass or a failure. Non-relative imports must come from a
 * one-entry allowlist (`node:crypto`), and no network primitive may be named anywhere in it.
 */

import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, test } from "vitest";
import { distEntry, ensureDistBuilt, packageRoot } from "./dist-build.js";

/** The only module the offline verifier may reach outside its own directory. */
const ALLOWED_EXTERNAL_MODULES = new Set(["node:crypto"]);

/** Anything that could open a socket, named as an identifier or a property. */
const NETWORK_NAMES = new Set([
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "EventSource",
  "sendBeacon",
  "navigator",
  "Request",
  "Response",
  "Headers",
  "createConnection",
  "createServer",
]);

/** …and the modules that provide them. */
const NETWORK_MODULES = [
  "http",
  "https",
  "http2",
  "net",
  "tls",
  "dns",
  "dgram",
  "undici",
  "node-fetch",
  "axios",
  "got",
  "superagent",
  "cross-fetch",
];

interface Module {
  path: string;
  specifiers: string[];
  names: Set<string>;
}

function parse(path: string): Module {
  const text = readFileSync(path, "utf8");
  const source = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.ESNext,
    true,
    path.endsWith(".js") ? ts.ScriptKind.JS : ts.ScriptKind.TS,
  );
  const specifiers: string[] = [];
  const names = new Set<string>();

  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require")) &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specifiers.push((node.arguments[0] as ts.StringLiteral).text);
    } else if (ts.isIdentifier(node)) {
      names.add(node.text);
    } else if (ts.isPropertyAccessExpression(node)) {
      names.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { path, specifiers, names };
}

/** Resolve a relative specifier the way NodeNext does: `./x.js` is emitted from `./x.ts`. */
function resolveRelative(from: string, specifier: string): string {
  const target = resolve(dirname(from), specifier);
  if (from.endsWith(".js")) return target;
  return target.replace(/\.js$/u, ".ts");
}

function walk(entry: string): Map<string, Module> {
  const graph = new Map<string, Module>();
  const queue = [entry];
  while (queue.length > 0) {
    const path = queue.pop()!;
    if (graph.has(path)) continue;
    const module = parse(path);
    graph.set(path, module);
    for (const specifier of module.specifiers) {
      if (specifier.startsWith("."))
        queue.push(resolveRelative(path, specifier));
    }
  }
  return graph;
}

function assertOffline(graph: Map<string, Module>, label: string): void {
  for (const module of graph.values()) {
    const where = `${label}:${relative(packageRoot, module.path)}`;
    for (const specifier of module.specifiers) {
      if (specifier.startsWith(".")) continue;
      expect(
        ALLOWED_EXTERNAL_MODULES.has(specifier),
        `${where} imports ${specifier}, which is not on the offline allowlist`,
      ).toBe(true);
    }
    for (const network of NETWORK_MODULES) {
      expect(
        module.specifiers.includes(network) ||
          module.specifiers.includes(`node:${network}`),
        `${where} imports the network module ${network}`,
      ).toBe(false);
    }
    for (const name of NETWORK_NAMES) {
      expect(
        module.names.has(name),
        `${where} references the network primitive ${name}`,
      ).toBe(false);
    }
  }
}

const sourceEntry = fileURLToPath(
  new URL("../../src/verify/index.js", import.meta.url),
).replace(/\.js$/u, ".ts");

test("the /verify source import graph reaches no network code", () => {
  const graph = walk(sourceEntry);
  assertOffline(graph, "src");

  const files = [...graph.keys()]
    .map((path) => relative(packageRoot, path))
    .sort();
  expect(files).toEqual([
    "src/verify/canonicalize.ts",
    "src/verify/index.ts",
    "src/verify/key-document.ts",
    "src/verify/rfc3339.ts",
    "src/verify/types.ts",
    "src/verify/verify.ts",
    // The webhook verifier belongs behind the same guarantee: deciding whether an inbound request is
    // genuine is a pure HMAC over bytes you already hold, and a receiver that had to call out to
    // decide would be a worse receiver.
    "src/verify/webhook.ts",
  ]);
  // discovery.ts and cli.ts are the two modules that do I/O. Neither is reachable from here.
  expect(files).not.toContain("src/verify/discovery.ts");
  expect(files).not.toContain("src/verify/cli.ts");
});

test("the shipped dist/verify import graph reaches no network code", () => {
  ensureDistBuilt();
  const graph = walk(distEntry);
  assertOffline(graph, "dist");
  expect(
    [...graph.keys()].map((path) => relative(packageRoot, path)).sort(),
  ).toEqual([
    "dist/verify/canonicalize.js",
    "dist/verify/index.js",
    "dist/verify/key-document.js",
    "dist/verify/rfc3339.js",
    "dist/verify/types.js",
    "dist/verify/verify.js",
    "dist/verify/webhook.js",
  ]);
});

test("the /verify subpath is wired to the offline entry point, not the API client", () => {
  const manifest = JSON.parse(
    readFileSync(resolve(packageRoot, "package.json"), "utf8"),
  );
  expect(manifest.exports["./verify"]).toEqual({
    types: "./dist/verify/index.d.ts",
    default: "./dist/verify/index.js",
  });
  // The root entry is the HTTP client and DOES use fetch — proving the subpath is a different file
  // is the point, so a future "simplification" that aliases them fails here.
  expect(manifest.exports["."].default).not.toBe(
    manifest.exports["./verify"].default,
  );
});

test("live key discovery stays reachable, on its own explicitly-network subpath", async () => {
  const manifest = JSON.parse(
    readFileSync(resolve(packageRoot, "package.json"), "utf8"),
  );
  expect(manifest.exports["./verify/discovery"]).toEqual({
    types: "./dist/verify/discovery.d.ts",
    default: "./dist/verify/discovery.js",
  });
  const discovery = await import("../../src/verify/discovery.js");
  expect(typeof discovery.discoverVerificationKeyDocument).toBe("function");
  // …and it is genuinely the network half, which is why it is not behind `/verify`.
  expect(
    parse(
      fileURLToPath(new URL("../../src/verify/discovery.ts", import.meta.url)),
    ).names.has("fetch"),
  ).toBe(true);
});

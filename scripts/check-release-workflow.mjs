#!/usr/bin/env node
/** Validates the package release and official MCP Registry publication workflows. */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const workflowPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  ".github",
  "workflows",
  "release.yml",
);
const yaml = readFileSync(workflowPath, "utf8");
const registryWorkflowPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  ".github",
  "workflows",
  "publish-mcp-registry.yml",
);
const registryYaml = readFileSync(registryWorkflowPath, "utf8");

let fail = 0;
const check = (name, cond) => {
  console.error(`${cond ? "✓" : "✗"} ${name}`);
  if (!cond) fail++;
};

function jobIds(content) {
  const start = content.indexOf("\njobs:\n");
  if (start < 0) return [];
  const rest = content.slice(start + "\njobs:\n".length);
  return [...rest.matchAll(/^  ([a-z][a-z0-9_-]*):\s*$/gm)].map((m) => m[1]);
}

function jobBlock(content, jobId) {
  const marker = `\n  ${jobId}:\n`;
  const start = content.indexOf(marker);
  if (start < 0) return "";
  const after = content.slice(start + marker.length);
  const next = after.search(/^  [a-z][a-z0-9_-]*:\s*$/m);
  return next < 0 ? after : after.slice(0, next);
}

check(
  "triggers on push tags v*",
  /push:\s*\n\s+tags:\s*\n\s+- "v\*"/.test(yaml),
);
check("supports workflow_dispatch", /workflow_dispatch:/.test(yaml));

const jobs = jobIds(yaml);
check(
  "defines npm, mcp, pypi, and official MCP Registry jobs",
  jobs.join(",") === "npm,mcp,pypi,mcp_registry",
);

const npm = jobBlock(yaml, "npm");
const mcp = jobBlock(yaml, "mcp");
const pypi = jobBlock(yaml, "pypi");
const mcpRegistry = jobBlock(yaml, "mcp_registry");

check(
  "npm job publishes with NPM_TOKEN + provenance",
  /secrets\.NPM_TOKEN/.test(npm) && /npm publish/.test(npm),
);
check("mcp job needs npm first", /needs:\s*(\[npm\]|npm\b)/.test(mcp));
check(
  "mcp job publishes packages/mcp",
  /packages\/mcp/.test(mcp) && /publish/.test(mcp),
);
check(
  "pypi job uses OIDC environment",
  /environment:\s*pypi/.test(pypi) && /gh-action-pypi-publish/.test(pypi),
);

check(
  "registry job waits for MCP npm publication",
  /needs:\s*(\[mcp\]|mcp\b)/.test(mcpRegistry),
);
check(
  "registry job calls the dedicated reusable workflow with OIDC",
  /uses:\s*\.\/\.github\/workflows\/publish-mcp-registry\.yml/.test(
    mcpRegistry,
  ) && /id-token:\s*write/.test(mcpRegistry),
);
check(
  "registry workflow supports workflow_call",
  /workflow_call:/.test(registryYaml),
);
check(
  "registry workflow supports workflow_dispatch recovery",
  /workflow_dispatch:/.test(registryYaml),
);
check(
  "registry workflow grants only its publish job OIDC",
  /id-token:\s*write/.test(registryYaml),
);
check(
  "registry workflow verifies the immutable version before publishing",
  /versions\/\$encoded_version/.test(registryYaml),
);
check(
  "registry workflow pins and verifies mcp-publisher",
  /v1\.7\.9/.test(registryYaml) && /sha256sum --check/.test(registryYaml),
);
check(
  "registry workflow authenticates with GitHub OIDC",
  /login github-oidc/.test(registryYaml),
);
check(
  "registry workflow publishes the explicit server manifest",
  /publish packages\/mcp\/server\.json/.test(registryYaml),
);

if (fail > 0) {
  console.error(`\n${fail} check(s) failed.`);
  process.exit(1);
}
console.error("\nRelease + official MCP Registry workflows OK.");

/**
 * Two of the verifier's guarantees are about the artifact npm actually ships, not about the
 * TypeScript sources: the `kaval-receipt-verify` bin has to run as a real process, and the compiled
 * `dist/verify/index.js` import graph has to stay free of network code. Both tests therefore need
 * `dist` to exist and to be no older than the sources, whether or not the caller remembered to run
 * `pnpm build` first.
 */

import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
export const distCli = fileURLToPath(
  new URL("../../dist/verify/cli.js", import.meta.url),
);
export const distEntry = fileURLToPath(
  new URL("../../dist/verify/index.js", import.meta.url),
);

const sourceDirectory = fileURLToPath(
  new URL("../../src/verify", import.meta.url),
);
const tsc = fileURLToPath(
  new URL("../../node_modules/typescript/lib/tsc.js", import.meta.url),
);

function modifiedAt(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return Number.NEGATIVE_INFINITY;
  }
}

function newestSourceMtime(): number {
  let newest = Number.NEGATIVE_INFINITY;
  for (const entry of readdirSync(sourceDirectory)) {
    newest = Math.max(newest, modifiedAt(`${sourceDirectory}/${entry}`));
  }
  return newest;
}

let built = false;

/** Build once per vitest worker, and only when `dist` is missing or stale. */
export function ensureDistBuilt(): void {
  if (built) return;
  const oldestArtifact = Math.min(modifiedAt(distCli), modifiedAt(distEntry));
  if (oldestArtifact < newestSourceMtime()) {
    execFileSync(process.execPath, [tsc, "-p", "tsconfig.build.json"], {
      cwd: packageRoot,
      stdio: "inherit",
    });
  }
  built = true;
}

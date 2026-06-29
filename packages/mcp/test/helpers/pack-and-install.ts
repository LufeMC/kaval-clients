import { execFile } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const clientsRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
const kavalDir = join(clientsRoot, "sdks/node");
const mcpDir = join(clientsRoot, "packages/mcp");

export type PackedInstall = {
  root: string;
  kavalEntry: string;
  mcpServerEntry: string;
  mcpBin: string;
  kavalRealPath: string;
  cleanup: () => void;
};

/** Build, npm-pack, and install `kaval` + `@usekaval/mcp` like a registry consumer (no workspace symlinks). */
export async function installPackedTarballs(): Promise<PackedInstall> {
  await execFileAsync("pnpm", ["exec", "tsc", "-p", "tsconfig.build.json"], {
    cwd: kavalDir,
  });
  await execFileAsync("pnpm", ["exec", "tsc", "-p", "tsconfig.build.json"], {
    cwd: mcpDir,
  });

  const packDir = mkdtempSync(join(tmpdir(), "kaval-pack-"));
  try {
    await execFileAsync("pnpm", ["pack", "--pack-destination", packDir], {
      cwd: kavalDir,
    });
    await execFileAsync("pnpm", ["pack", "--pack-destination", packDir], {
      cwd: mcpDir,
    });
    const kavalTar = readdirSync(packDir).find(
      (f) => f.startsWith("kaval-") && f.endsWith(".tgz") && !f.includes("mcp"),
    );
    const mcpTar = readdirSync(packDir).find(
      (f) => f.startsWith("usekaval-mcp-") && f.endsWith(".tgz"),
    );
    if (!kavalTar || !mcpTar) {
      throw new Error(
        `expected packed tarballs in ${packDir}, got ${readdirSync(packDir)}`,
      );
    }

    const packedMcp = JSON.parse(
      (
        await execFileAsync("tar", [
          "-xOf",
          join(packDir, mcpTar),
          "package/package.json",
        ])
      ).stdout,
    ) as { dependencies?: Record<string, string> };
    for (const spec of Object.values(packedMcp.dependencies ?? {})) {
      if (spec.startsWith("workspace:")) {
        throw new Error(
          `@usekaval/mcp tarball still declares workspace dependency ${spec} — npm consumers cannot install it`,
        );
      }
    }

    const root = mkdtempSync(join(tmpdir(), "kaval-published-"));
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        name: "published-smoke",
        private: true,
        type: "module",
      }),
    );

    try {
      await execFileAsync(
        "npm",
        [
          "install",
          "--omit=dev",
          "--no-package-lock",
          join(packDir, kavalTar),
          join(packDir, mcpTar),
        ],
        { cwd: root },
      );
    } catch (e) {
      rmSync(root, { recursive: true, force: true });
      throw e;
    }

    const kavalPath = join(root, "node_modules/kaval");
    const mcpPath = join(root, "node_modules/@usekaval/mcp");

    return {
      root,
      kavalEntry: pathToFileURL(join(kavalPath, "dist/index.js")).href,
      mcpServerEntry: pathToFileURL(join(mcpPath, "dist/server.js")).href,
      mcpBin: join(mcpPath, "dist/bin.js"),
      kavalRealPath: realpathSync(kavalPath),
      cleanup: () => {
        rmSync(root, { recursive: true, force: true });
        rmSync(packDir, { recursive: true, force: true });
      },
    };
  } catch (e) {
    rmSync(packDir, { recursive: true, force: true });
    throw e;
  }
}

/** True when `path` resolves inside the monorepo workspace (pnpm link), not a packed copy. */
export function isWorkspaceLinkedPackage(
  installedRealPath: string,
  packageDir: string,
): boolean {
  const workspaceReal = realpathSync(packageDir);
  return (
    installedRealPath === workspaceReal ||
    installedRealPath.startsWith(`${workspaceReal}/`)
  );
}

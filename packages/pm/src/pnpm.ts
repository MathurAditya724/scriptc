// Driving pnpm: run the CLI, then enumerate installed package instances from
// the isolated `node_modules/.pnpm` layout (DESIGN.md §4.5, §10.2).
//
// The layout is walked instead of parsing `pnpm ls --json --depth Infinity`:
// it is the same information (one directory per instance, the package as the
// only real directory in `.pnpm/<instance>/node_modules`), it is stable across
// pnpm 9-12, and it avoids a multi-megabyte JSON tree with repeated subtrees.

import { readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { isDir, isSymlink, readText, runInherit } from "./util.js";

export interface Instance {
  name: string;
  version: string;
  /** pnpm's instance directory name, e.g. `fast-glob@3.3.3`. */
  instanceId: string;
  /** Realpath of the installed package directory. */
  installedDir: string;
  /** `.pnpm/<instance>/node_modules`: the package plus its resolved deps. */
  depsDir: string;
}

export async function pnpmInstall(projectDir: string, args: string[]): Promise<number> {
  const pnpm = process.env["SPM_PNPM"] ?? "pnpm";
  return runInherit(pnpm, ["install", ...args], projectDir);
}

interface PackageIdentity {
  name?: string;
  version?: string;
}

export function enumerateInstances(projectDir: string): Instance[] {
  const store = join(projectDir, "node_modules", ".pnpm");
  if (!isDir(store)) {
    throw new Error(
      "node_modules/.pnpm not found: scriptc-pm needs a pnpm install with the isolated linker",
    );
  }
  const instances: Instance[] = [];
  for (const instanceId of readdirSync(store).sort()) {
    const depsDir = join(store, instanceId, "node_modules");
    if (!isDir(depsDir)) continue;
    for (const candidate of packageDirsIn(depsDir)) {
      const text = readText(join(candidate, "package.json"));
      if (text === null) continue;
      const pkg = JSON.parse(text) as PackageIdentity;
      if (pkg.name === undefined || pkg.version === undefined) continue;
      instances.push({
        name: pkg.name,
        version: pkg.version,
        instanceId: instanceId,
        installedDir: realpathSync(candidate),
        depsDir: depsDir,
      });
    }
  }
  return instances;
}

/** The real (non-symlink) package directories directly inside `depsDir`. */
function packageDirsIn(depsDir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(depsDir).sort()) {
    if (entry === ".bin") continue;
    const abs = join(depsDir, entry);
    if (entry.startsWith("@")) {
      if (!isDir(abs) || isSymlink(abs)) continue;
      for (const inner of readdirSync(abs).sort()) {
        const innerAbs = join(abs, inner);
        if (!isSymlink(innerAbs) && isDir(innerAbs)) out.push(innerAbs);
      }
    } else if (!isSymlink(abs) && isDir(abs)) {
      out.push(abs);
    }
  }
  return out;
}

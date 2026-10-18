// Working inside a fetched source tree: locating the package directory
// (DESIGN.md §5.3.1) and computing the effective tsconfig (§5.3.2) with the
// semantic options the compiler cares about (§6.5).

import { dirname, join, relative, resolve } from "node:path";
import { isDir, isFile, readText, stripJsonc, walkFiles } from "./util.js";

const SKIP_DIRS = new Set(["node_modules", ".git"]);

interface NamedPackage {
  name?: string;
  version?: string;
}

/** The directory (relative to `root`, "" for the root) whose package.json
 * names `name`. `hint` (repository.directory) wins when it matches; a
 * matching version breaks ties. */
export function locatePackageDir(
  root: string,
  name: string,
  version: string,
  hint: string,
): string | null {
  const nameAt = (rel: string): NamedPackage | null => {
    const text = readText(join(root, rel, "package.json"));
    if (text === null) return null;
    try {
      return JSON.parse(text) as NamedPackage;
    } catch {
      return null;
    }
  };
  const cleanHint = hint.replace(/^\.?\//, "").replace(/\/$/, "");
  if (cleanHint !== "" && nameAt(cleanHint)?.name === name) return cleanHint;
  let best: string | null = null;
  for (const file of walkFiles(root, SKIP_DIRS)) {
    if (file !== "package.json" && !file.endsWith("/package.json")) continue;
    const rel = file === "package.json" ? "" : file.slice(0, -"/package.json".length);
    const pkg = nameAt(rel);
    if (pkg === null || pkg.name !== name) continue;
    if (pkg.version === version) return rel;
    // Prefer the shallowest match among version mismatches (uncommitted bumps).
    if (best === null || rel.split("/").length < best.split("/").length) best = rel;
  }
  return best;
}

export interface TsOptions {
  /** Raw compilerOptions, merged along the `extends` chain. */
  options: Record<string, unknown>;
  /** `include` patterns, relative to the package dir. */
  include: string[];
  /** True when an `extends` target could not be read (npm presets). */
  partial: boolean;
  /** The tsconfig file used, relative to the package dir. */
  file: string;
}

function readTsconfig(path: string): Record<string, unknown> | null {
  const text = readText(path);
  if (text === null) return null;
  try {
    return JSON.parse(stripJsonc(text)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** The effective tsconfig of the package directory, following `extends`
 * within the tree. Paths outside `treeRoot` are not read. */
export function effectiveTsconfig(treeRoot: string, pkgDir: string): TsOptions {
  const result: TsOptions = { options: {}, include: [], partial: false, file: "" };
  let file = "";
  for (const candidate of ["tsconfig.build.json", "tsconfig.lib.json", "tsconfig.json"]) {
    if (isFile(join(pkgDir, candidate))) {
      file = candidate;
      break;
    }
  }
  if (file === "") return result;
  result.file = file;
  const chain: Record<string, unknown>[] = [];
  let includeFrom = "";
  let current = join(pkgDir, file);
  const root = resolve(treeRoot);
  for (let depth = 0; depth < 8; depth += 1) {
    const config = readTsconfig(current);
    if (config === null) {
      result.partial = true;
      break;
    }
    chain.push(config);
    if (includeFrom === "" && Array.isArray(config["include"])) {
      includeFrom = dirname(current);
      for (const pattern of config["include"] as unknown[]) {
        if (typeof pattern === "string") {
          result.include.push(relative(pkgDir, join(includeFrom, pattern)));
        }
      }
    }
    let ext = config["extends"];
    if (Array.isArray(ext)) {
      // Array-form extends: later entries win; the POC follows the last one.
      const items = ext as unknown[];
      ext = items.length > 0 ? items[items.length - 1] : undefined;
    }
    if (typeof ext !== "string") break;
    if (!ext.startsWith(".")) {
      // An npm preset (@tsconfig/*): not resolved in the POC.
      result.partial = true;
      break;
    }
    let next = resolve(dirname(current), ext);
    if (!next.endsWith(".json")) next = `${next}.json`;
    if (!next.startsWith(root)) {
      result.partial = true;
      break;
    }
    current = next;
  }
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    const opts = (chain[i] as Record<string, unknown>)["compilerOptions"];
    if (typeof opts !== "object" || opts === null) continue;
    const record = opts as Record<string, unknown>;
    for (const key of Object.keys(record)) result.options[key] = record[key];
  }
  return result;
}

export function optionString(ts: TsOptions, key: string): string {
  const value = ts.options[key];
  return typeof value === "string" ? value.toLowerCase() : "";
}

export function optionBool(ts: TsOptions, key: string): boolean | null {
  const value = ts.options[key];
  return typeof value === "boolean" ? value : null;
}

const TARGET_ORDER = [
  "es3",
  "es5",
  "es6",
  "es2015",
  "es2016",
  "es2017",
  "es2018",
  "es2019",
  "es2020",
  "es2021",
  "es2022",
  "es2023",
  "es2024",
  "esnext",
];

/** `useDefineForClassFields`, explicit or derived from the target. */
export function useDefineForClassFields(ts: TsOptions): boolean {
  const explicit = optionBool(ts, "useDefineForClassFields");
  if (explicit !== null) return explicit;
  const target = optionString(ts, "target");
  if (target === "") return true;
  return TARGET_ORDER.indexOf(target) >= TARGET_ORDER.indexOf("es2022");
}

/** Source files (relative to the package dir) the build compiles: the
 * tsconfig `include` directories, else `src/`, else top-level files. Tests
 * and declaration files are left out. */
export function sourceFilesOf(pkgDir: string, ts: TsOptions): string[] {
  const roots: string[] = [];
  for (const pattern of ts.include) {
    let base = pattern.split("/*")[0] ?? "";
    if (base.includes("*")) base = "";
    if (base.startsWith("..")) continue;
    if (/\.[cm]?tsx?$/.test(base)) roots.push(base);
    else if (!roots.includes(base)) roots.push(base);
  }
  if (roots.length === 0) roots.push(isDir(join(pkgDir, "src")) ? "src" : "");
  const out = new Set<string>();
  for (const root of roots) {
    if (root !== "" && isFile(join(pkgDir, root))) {
      if (isSourceFile(root)) out.add(root);
      continue;
    }
    const abs = root === "" ? pkgDir : join(pkgDir, root);
    if (!isDir(abs)) continue;
    const skip = new Set([
      "node_modules",
      ".git",
      "dist",
      "__tests__",
      "__mocks__",
      "test",
      "tests",
      "fixtures",
    ]);
    for (const file of walkFiles(abs, skip)) {
      const rel = root === "" ? file : `${root}/${file}`;
      if (root === "" && rel.includes("/")) continue;
      if (isSourceFile(rel)) out.add(rel);
    }
  }
  return [...out].sort();
}

export function isSourceFile(rel: string): boolean {
  if (!/\.[cm]?tsx?$/.test(rel) || /\.d\.[cm]?ts$/.test(rel)) return false;
  return !/\.(test|spec|bench)\.[cm]?tsx?$/.test(rel);
}

/** The package's ambient declaration files: the `.d.ts` files among
 * `files` (relative to the package dir) that its tsconfig `include`
 * covers. Its build loads them as roots without importing them (module
 * augmentations such as typescript-estree's `typings/typescript.d.ts`). */
export function ambientDeclarationsOf(ts: TsOptions, files: string[]): string[] {
  const roots: string[] = [];
  for (const pattern of ts.include) {
    let base = pattern.split("/*")[0] ?? "";
    if (base.includes("*")) base = "";
    if (base.startsWith("..")) continue;
    if (!roots.includes(base)) roots.push(base);
  }
  return files
    .filter(
      (file) =>
        /\.d\.[cm]?ts$/.test(file) &&
        roots.some((root) =>
          root === "" ? !file.includes("/") : file === root || file.startsWith(`${root}/`),
        ),
    )
    .sort();
}

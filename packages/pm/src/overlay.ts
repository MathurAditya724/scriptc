// Building and materializing an overlay (DESIGN.md §5.3, §5.4):
// entry mapping from published targets to source files, the closure check
// for modules the source imports but the tree lacks (codegen, §9.1), and the
// on-disk overlay with its `node_modules` link to pnpm's resolved deps.

import { builtinModules } from "node:module";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, normalize } from "node:path";
import type { ExportMap } from "./manifest.js";
import type { Published } from "./published.js";
import { importsOf, tokenize } from "./tokens.js";
import { copyTree, gitBlobSha1, isDir, isFile, readText, sha256Hex } from "./util.js";

const BUILTINS = new Set(builtinModules);

/** Map every published export target to a source file. Unmapped targets are
 * returned in `unmapped`. Paths in the map are overlay-relative with "./". */
export function buildExportMap(
  pub: Published,
  pubToSrc: Map<string, string>,
  srcDir: string,
): { exports: ExportMap; unmapped: string[] } {
  const exports: ExportMap = {};
  const unmapped: string[] = [];
  for (const t of pub.targets) {
    const src = sourceForTarget(t.target, t.subpath, pubToSrc, srcDir);
    if (src === null) {
      unmapped.push(`${t.subpath} (${t.condition}: ${t.target})`);
      continue;
    }
    // Written as a fresh non-union local: narrowing `exports[k]` from
    // `Record | undefined` and writing through it trips a scriptc ICE.
    const entry: Record<string, string> = exports[t.subpath] ?? {};
    entry[t.condition] = `./${src}`;
    entry["types"] = `./${src}`;
    exports[t.subpath] = entry;
  }
  return { exports: exports, unmapped: unmapped };
}

function sourceForTarget(
  target: string,
  subpath: string,
  pubToSrc: Map<string, string>,
  srcDir: string,
): string | null {
  const direct = pubToSrc.get(target);
  if (direct !== undefined) return direct;
  // A bundle's map lists many sources; pick the one named like the bundle.
  const stem = basename(target).replace(/\.[cm]?js$/, "");
  const guesses: string[] = [];
  if (subpath === ".")
    guesses.push(`src/${stem}.ts`, "src/index.ts", "index.ts", "lib/index.ts", "source/index.ts");
  else {
    const sub = subpath.replace(/^\.\//, "");
    guesses.push(`src/${sub}.ts`, `src/${sub}/index.ts`, `${sub}.ts`);
  }
  for (const g of guesses) {
    if (isFile(join(srcDir, g))) return g;
  }
  return null;
}

/** Relative imports that do not resolve inside the overlay and bare imports
 * that do not resolve to an installed dependency, over the runtime closure
 * of the mapped entries. */
export function closureProblems(srcDir: string, depsDir: string, entries: string[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  const queue = [...entries];
  while (queue.length > 0) {
    const rel = queue.shift() as string;
    if (seen.has(rel)) continue;
    seen.add(rel);
    const text = readText(join(srcDir, rel));
    if (text === null) continue;
    for (const ref of importsOf(tokenize(text))) {
      if (ref.typeOnly) continue;
      const spec = ref.specifier;
      if (spec.startsWith(".")) {
        const target = resolveSource(srcDir, rel, spec);
        if (target === null) problems.push(`missing-module: ${join(dirname(rel), spec)}`);
        else if (/\.[cm]?tsx?$/.test(target)) queue.push(target);
        continue;
      }
      if (spec.startsWith("node:") || spec.startsWith("#")) continue;
      const name = spec.startsWith("@")
        ? spec.split("/").slice(0, 2).join("/")
        : (spec.split("/")[0] ?? spec);
      if (BUILTINS.has(name)) continue;
      if (!isDir(join(depsDir, name))) problems.push(`unresolved-import: ${spec} (from ${rel})`);
    }
  }
  return [...new Set(problems)];
}

const SOURCE_EXTS = [".ts", ".tsx", ".mts", ".cts", ".d.ts", ".js", ".json"];

export function resolveSource(root: string, fromRel: string, spec: string): string | null {
  const base = normalize(join(dirname(fromRel), spec));
  if (base.startsWith("..")) return null;
  const candidates: string[] = [];
  const m = /\.([cm]?)js$/.exec(base);
  if (m !== null) {
    const stem = base.slice(0, base.length - m[0].length);
    candidates.push(`${stem}.${m[1] ?? ""}ts`, `${stem}.tsx`);
  }
  candidates.push(base);
  for (const ext of SOURCE_EXTS) candidates.push(`${base}${ext}`);
  for (const ext of SOURCE_EXTS) candidates.push(`${base}/index${ext}`);
  for (const c of candidates) {
    if (isFile(join(root, c))) return c;
  }
  return null;
}

export interface OverlayInput {
  overlayDir: string;
  srcDir: string;
  files: string[];
  depsDir: string;
  name: string;
  version: string;
  type: string;
  exports: ExportMap;
  imports: unknown;
}

interface OverlayPackageJson {
  name: string;
  version: string;
  type: string;
  exports: ExportMap;
  imports?: unknown;
}

/** Write the overlay and return its sourceTreeHash: sha256 over the sorted
 * `path NUL gitBlobSha1` lines of the files taken from the source tree. */
export function materializeOverlay(input: OverlayInput): string {
  rmSync(input.overlayDir, { recursive: true, force: true });
  mkdirSync(input.overlayDir, { recursive: true });
  const taken = input.files.filter((f) => f !== "package.json");
  copyTree(input.srcDir, input.overlayDir, taken);
  const pkg: OverlayPackageJson = {
    name: input.name,
    version: input.version,
    type: input.type,
    exports: input.exports,
  };
  if (input.imports !== undefined) pkg.imports = input.imports;
  writeFileSync(join(input.overlayDir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
  symlinkSync(input.depsDir, join(input.overlayDir, "node_modules"));
  let lines = "";
  for (const rel of taken) {
    lines += `${rel}\0${gitBlobSha1(readFileSync(join(input.srcDir, rel)))}\n`;
  }
  return `sha256-${sha256Hex(lines)}`;
}

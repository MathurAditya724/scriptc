// What the installed (published) package looks like: its manifest, its JS
// files, its source maps, and its export targets. Everything is read from the
// installed files, so no registry access is needed for the content check
// (DESIGN.md §8.1).

import { dirname, join, normalize } from "node:path";
import { isDir, isFile, readText, walkFiles } from "./util.js";

export interface SourceMapInfo {
  /** The generated file, relative to the package root. */
  file: string;
  /** Map sources resolved against the package root (may start with ../). */
  sources: string[];
  /** sourcesContent, aligned with `sources`; null where absent. */
  contents: (string | null)[];
}

export interface ExportTarget {
  subpath: string;
  condition: string;
  /** Package-relative file, without "./". */
  target: string;
}

export interface Published {
  dir: string;
  pkg: Record<string, unknown>;
  files: string[];
  jsFiles: string[];
  maps: SourceMapInfo[];
  targets: ExportTarget[];
  /** "cjs", "esm" or "dual" (DESIGN.md §5.6.7). */
  format: string;
}

interface RawSourceMap {
  sources?: string[];
  sourcesContent?: (string | null)[];
  sourceRoot?: string;
}

const SKIP = new Set(["node_modules"]);
const RUNTIME_CONDITIONS = new Set(["import", "require", "node", "default", "module"]);

export function readPublished(dir: string): Published {
  const pkgText = readText(join(dir, "package.json")) ?? "{}";
  const pkg = JSON.parse(pkgText) as Record<string, unknown>;
  const files = walkFiles(dir, SKIP);
  const jsFiles = files.filter((f) => /\.[cm]?js$/.test(f));
  const maps: SourceMapInfo[] = [];
  for (const file of files) {
    if (!/\.[cm]?js\.map$/.test(file)) continue;
    const text = readText(join(dir, file));
    if (text === null) continue;
    let raw: RawSourceMap;
    try {
      raw = JSON.parse(text) as RawSourceMap;
    } catch {
      continue;
    }
    const base = join(dirname(file), raw.sourceRoot ?? "");
    const sources = (raw.sources ?? []).map((s) =>
      s.startsWith("webpack://") ? s : normalize(join(base, s)),
    );
    const contents: (string | null)[] = [];
    for (let i = 0; i < sources.length; i += 1) contents.push(raw.sourcesContent?.[i] ?? null);
    maps.push({ file: file.slice(0, -".map".length), sources: sources, contents: contents });
  }
  const targets = exportTargets(pkg, dir);
  return {
    dir: dir,
    pkg: pkg,
    files: files,
    jsFiles: jsFiles,
    maps: maps,
    targets: targets,
    format: publishedFormat(pkg, targets),
  };
}

function publishedFormat(pkg: Record<string, unknown>, targets: ExportTarget[]): string {
  let esm = false;
  let cjs = false;
  for (const t of targets) {
    if (t.condition === "import" || t.target.endsWith(".mjs")) esm = true;
    else if (t.condition === "require" || t.target.endsWith(".cjs")) cjs = true;
  }
  if (esm && cjs) return "dual";
  if (pkg["type"] === "module" || esm) return "esm";
  return "cjs";
}

/** Resolve a manifest path the way Node does for main: exact file, then
 * `.js`, then `/index.js`. */
function resolveTarget(dir: string, target: string): string | null {
  const rel = normalize(target).replace(/^\.\//, "");
  if (rel.includes("*")) return null;
  if (isFile(join(dir, rel))) return rel;
  if (isFile(join(dir, `${rel}.js`))) return `${rel}.js`;
  if (isDir(join(dir, rel)) && isFile(join(dir, rel, "index.js"))) return `${rel}/index.js`;
  return null;
}

function collectConditions(
  value: unknown,
  subpath: string,
  outer: string,
  dir: string,
  out: ExportTarget[],
): void {
  if (typeof value === "string") {
    if (outer === "") return;
    const target = resolveTarget(dir, value);
    if (target !== null && !/\.d\.[cm]?ts$/.test(target)) {
      out.push({ subpath: subpath, condition: outer, target: target });
    }
    return;
  }
  if (Array.isArray(value)) {
    const items = value as unknown[];
    if (items.length > 0) collectConditions(items[0], subpath, outer, dir, out);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (outer === "" && !RUNTIME_CONDITIONS.has(key)) continue;
    collectConditions(record[key], subpath, outer === "" ? key : outer, dir, out);
  }
}

export function exportTargets(pkg: Record<string, unknown>, dir: string): ExportTarget[] {
  const out: ExportTarget[] = [];
  const exp = pkg["exports"];
  if (exp !== undefined && exp !== null) {
    if (typeof exp === "string" || Array.isArray(exp)) {
      collectConditions(exp, ".", "default", dir, out);
    } else if (typeof exp === "object") {
      const record = exp as Record<string, unknown>;
      const keys = Object.keys(record);
      if (keys.length > 0 && (keys[0] as string).startsWith(".")) {
        for (const key of keys) {
          if (key.includes("*") || key === "./package.json") continue;
          collectConditions(
            record[key],
            key,
            typeof record[key] === "string" ? "default" : "",
            dir,
            out,
          );
        }
      } else {
        collectConditions(exp, ".", "", dir, out);
      }
    }
    return out;
  }
  const main = typeof pkg["main"] === "string" ? (pkg["main"] as string) : "index.js";
  const mainTarget = resolveTarget(dir, main);
  if (mainTarget !== null) out.push({ subpath: ".", condition: "default", target: mainTarget });
  if (typeof pkg["module"] === "string") {
    const moduleTarget = resolveTarget(dir, pkg["module"] as string);
    if (moduleTarget !== null)
      out.push({ subpath: ".", condition: "import", target: moduleTarget });
  }
  return out;
}

/** The published declaration entry for the root subpath. */
export function typesEntry(pub: Published): string | null {
  const candidates: string[] = [];
  const exp = pub.pkg["exports"];
  const findTypes = (value: unknown): void => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return;
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      const inner = record[key];
      if (key === "types" && typeof inner === "string") candidates.push(inner);
      else if (!key.startsWith(".") || key === ".") findTypes(inner);
    }
  };
  if (typeof exp === "object" && exp !== null) {
    const record = exp as Record<string, unknown>;
    findTypes(record["."] !== undefined ? { ".": record["."] } : record);
  }
  for (const key of ["types", "typings"]) {
    const value = pub.pkg[key];
    if (typeof value === "string") candidates.push(value);
  }
  for (const t of pub.targets) {
    if (t.subpath === ".") candidates.push(t.target.replace(/\.([cm]?)js$/, ".d.$1ts"));
  }
  candidates.push("index.d.ts");
  for (const c of candidates) {
    const rel = normalize(c).replace(/^\.\//, "");
    if (isFile(join(pub.dir, rel))) return rel;
  }
  return null;
}

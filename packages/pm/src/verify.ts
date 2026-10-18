// The acceptance gate (DESIGN.md §6): does the candidate source correspond to
// the published artifact the user already runs under Node?
//
// - exact (§6.3.1): shipped `.ts` files and shipped `sourcesContent` are
//   byte-equal to the candidate tree.
// - equivalent (§6.3.2): the candidate is re-emitted with the TypeScript
//   compiler found in the environment and compared, per module, with the
//   published JS after token normalization.
// - structural (§6.3.3): for bundles without maps, per-module literal and
//   member-name multisets match the bundle's `// src/x.ts` segments.
// - surface (§6.4): exported names of the source entry equal those of the
//   published declaration entry.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, normalize } from "node:path";
import type { ContentLevel, SurfaceLevel } from "./manifest.js";
import type { Published } from "./published.js";
import { typesEntry } from "./published.js";
import type { Token } from "./tokens.js";
import { exportsOf, firstDifference, normalizeEmit, tokenize } from "./tokens.js";
import type { TsOptions } from "./tree.js";
import { optionString } from "./tree.js";
import { baseEnv, isFile, readText, run, walkFiles } from "./util.js";

export interface ContentResult {
  level: ContentLevel;
  /** Checks that ran, for the lock (e.g. "sourcesContent 12/12"). */
  checks: string[];
  detail: string;
  /** Published JS file → source file (package-relative), when known. */
  pubToSrc: Map<string, string>;
}

const DEBUG = process.env["SPM_DEBUG"] === "1";
const TS_SOURCE = /\.([cm]?ts|tsx)$/;
const DECLARATION = /\.d\.[cm]?ts$/;

// ── exact ────────────────────────────────────────────────────────────────

/** Byte-compare shipped TS (files and map sourcesContent) with `srcDir`.
 * Returns null when the tarball carries no TS to compare. */
export function exactCheck(pub: Published, srcDir: string): ContentResult | null {
  let total = 0;
  let equal = 0;
  let firstMismatch = "";
  const pubToSrc = new Map<string, string>();
  const compare = (rel: string, content: string): void => {
    total += 1;
    const actual = readText(join(srcDir, rel));
    if (actual === content) equal += 1;
    else if (firstMismatch === "")
      firstMismatch = actual === null ? `${rel} missing` : `${rel} differs`;
  };
  for (const map of pub.maps) {
    const tsSources: string[] = [];
    for (let i = 0; i < map.sources.length; i += 1) {
      const source = map.sources[i] as string;
      const content = map.contents[i] ?? null;
      if (!TS_SOURCE.test(source) || DECLARATION.test(source)) continue;
      if (source.startsWith("..") || source.includes("node_modules/")) continue;
      tsSources.push(source);
      if (content !== null) compare(source, content);
    }
    if (tsSources.length === 1) pubToSrc.set(map.file, tsSources[0] as string);
  }
  const mapsTotal = total;
  for (const file of pub.files) {
    if (!TS_SOURCE.test(file) || DECLARATION.test(file)) continue;
    const content = readText(join(pub.dir, file));
    if (content !== null) compare(file, content);
  }
  if (total === 0) return null;
  const checks = [
    `sourcesContent ${mapsTotal === 0 ? "n/a" : "checked"}`,
    `exact ${equal}/${total}`,
  ];
  if (equal === total) return { level: "exact", checks: checks, detail: "", pubToSrc: pubToSrc };
  return { level: "mismatch", checks: checks, detail: firstMismatch, pubToSrc: pubToSrc };
}

// ── equivalent ───────────────────────────────────────────────────────────

export interface Emitter {
  /** Command and leading args that run `tsc`. */
  command: string;
  prefix: string[];
}

export function findTsc(projectDir: string): Emitter | null {
  const explicit = process.env["SPM_TSC"];
  if (explicit !== undefined && explicit !== "") {
    return explicit.endsWith(".js")
      ? { command: "node", prefix: [explicit] }
      : { command: explicit, prefix: [] };
  }
  const local = join(projectDir, "node_modules", "typescript", "bin", "tsc");
  if (isFile(local)) return { command: "node", prefix: [local] };
  return { command: "tsc", prefix: [] };
}

const PASSTHROUGH = [
  "importHelpers",
  "esModuleInterop",
  "allowSyntheticDefaultImports",
  "useDefineForClassFields",
  "experimentalDecorators",
  "emitDecoratorMetadata",
  "jsx",
  "jsxFactory",
  "jsxFragmentFactory",
  "jsxImportSource",
  "downlevelIteration",
  "preserveConstEnums",
  "verbatimModuleSyntax",
  "noEmitHelpers",
];

const FALLBACK_TARGETS = ["es2019", "es2017", "es2015", "es5", "es2020", "es2022", "esnext"];

interface EmitRun {
  files: Map<string, string>;
  error: string;
}

async function emit(
  tsc: Emitter,
  srcDir: string,
  files: string[],
  ts: TsOptions,
  moduleKind: string,
  target: string,
): Promise<EmitRun> {
  const tmp = mkdtempSync(join(tmpdir(), "spm-emit-"));
  try {
    const options: Record<string, unknown> = {};
    for (const key of PASSTHROUGH) {
      const value = ts.options[key];
      if (value !== undefined) options[key] = value;
    }
    options["target"] = target;
    options["module"] = moduleKind;
    if (moduleKind === "commonjs") options["moduleResolution"] = "node10";
    else if (moduleKind === "node16" || moduleKind === "nodenext")
      options["moduleResolution"] = moduleKind;
    else options["moduleResolution"] = "bundler";
    options["rootDir"] = srcDir;
    options["outDir"] = join(tmp, "out");
    options["noCheck"] = true;
    options["noResolve"] = true;
    options["noEmitOnError"] = false;
    options["declaration"] = false;
    options["sourceMap"] = false;
    options["skipLibCheck"] = true;
    options["allowImportingTsExtensions"] = false;
    // Harmless when the source uses .js specifiers; required when it uses .ts
    // specifiers and the tsconfig that enabled it was not readable.
    options["rewriteRelativeImportExtensions"] = true;
    options["types"] = [];
    options["ignoreDeprecations"] = "5.0";
    const config = { compilerOptions: options, files: files.map((f) => join(srcDir, f)) };
    writeFileSync(join(tmp, "tsconfig.json"), JSON.stringify(config));
    const res = await run(
      tsc.command,
      [...tsc.prefix, "-p", join(tmp, "tsconfig.json")],
      tmp,
      baseEnv(),
    );
    const out = new Map<string, string>();
    const outDir = join(tmp, "out");
    for (const rel of walkFiles(outDir, new Set<string>())) {
      const text = readText(join(outDir, rel));
      if (text !== null && /\.[cm]?js$/.test(rel)) out.set(rel, text);
    }
    // tsc exits nonzero for diagnostics even with noCheck; only a run that
    // emitted nothing is a failure.
    const error =
      out.size === 0 ? ((res.stdout + res.stderr).trim().split("\n")[0] ?? "no output") : "";
    return { files: out, error: error };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function normExt(rel: string): string {
  return rel.replace(/\.[cm]?js$/, ".js");
}

function prefixIndex(paths: string[], maxDepth: number): Map<string, Map<string, string>> {
  const index = new Map<string, Map<string, string>>();
  for (const path of paths) {
    const segs = path.split("/");
    for (let m = 0; m <= Math.min(maxDepth, segs.length - 1); m += 1) {
      const prefix = segs.slice(0, m).join("/");
      let bucket = index.get(prefix);
      if (bucket === undefined) {
        bucket = new Map<string, string>();
        index.set(prefix, bucket);
      }
      bucket.set(normExt(segs.slice(m).join("/")), path);
    }
  }
  return index;
}

const BUNDLE_MARKER = /^\/\/(?:#region)? ([^\n]+\.[cm]?tsx?)\s*$/gm;

function isBundle(text: string): boolean {
  const re = new RegExp(BUNDLE_MARKER.source, "gm");
  return re.exec(text) !== null && re.exec(text) !== null;
}

interface Pairing {
  pairs: [string, string][];
  equal: number;
  firstDiff: string;
}

function comparePairs(emitted: Map<string, string>, pub: Published, bundles: Set<string>): Pairing {
  const candidates = pub.jsFiles.filter((f) => !bundles.has(f));
  const pubIndex = prefixIndex(candidates, 3);
  const emitIndex = prefixIndex([...emitted.keys()], 2);
  let best: Pairing = { pairs: [], equal: 0, firstDiff: "" };
  for (const emitBucket of emitIndex.values()) {
    for (const pubBucket of pubIndex.values()) {
      const pairs: [string, string][] = [];
      for (const [rest, emittedPath] of emitBucket) {
        const pubPath = pubBucket.get(rest);
        if (pubPath !== undefined) pairs.push([pubPath, emittedPath]);
      }
      if (pairs.length === 0 || pairs.length < best.pairs.length) continue;
      let equal = 0;
      let firstDiff = "";
      for (const [pubPath, emittedPath] of pairs) {
        const published = normalizeEmit(tokenize(readText(join(pub.dir, pubPath)) ?? ""));
        const ours = normalizeEmit(tokenize(emitted.get(emittedPath) ?? ""));
        const diff = firstDifference(published, ours);
        if (diff === null) equal += 1;
        else if (firstDiff === "") {
          firstDiff = `${pubPath}: published «${diff.expected}» vs source «${diff.actual}»`;
        }
      }
      if (pairs.length > best.pairs.length || equal > best.equal) {
        best = { pairs: pairs, equal: equal, firstDiff: firstDiff };
      }
    }
  }
  return best;
}

/** Multiset fingerprint: string/template literals and member names, in
 * sorted order. Numeric literals are left out: esbuild constant-folds enum
 * initializers (`1 << 16`) and inlines enum members, tsc does not. */
function fingerprint(tokens: Token[]): string {
  const items: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i] as Token;
    if (t.kind === "str" || t.kind === "tpl") items.push(`${t.kind}:${t.value}`);
    else if (t.kind === "id" && i > 0 && tokens[i - 1]?.value === ".") items.push(`.${t.value}`);
  }
  items.sort();
  return items.join("\n");
}

/** Replace `E.Member` with its value for enums declared in the module
 * (`E[E["Member"] = 1] = "Member"`): esbuild inlines local enum members,
 * tsc does not. */
function inlineEnums(tokens: Token[]): Token[] {
  const values = new Map<string, string>();
  for (let i = 0; i + 8 < tokens.length; i += 1) {
    const t = tokens;
    if (
      t[i]?.kind === "id" &&
      t[i + 1]?.value === "[" &&
      t[i + 2]?.value === t[i]?.value &&
      t[i + 3]?.value === "[" &&
      t[i + 4]?.kind === "str" &&
      t[i + 5]?.value === "]" &&
      t[i + 6]?.value === "=" &&
      t[i + 7]?.kind === "num"
    ) {
      values.set(
        `${(t[i] as Token).value}.${(t[i + 4] as Token).value}`,
        (t[i + 7] as Token).value,
      );
    }
  }
  if (values.size === 0) return tokens;
  const out: Token[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i] as Token;
    // Drop the member definitions themselves: esbuild removes an unexported
    // enum object once every use is inlined.
    if (
      t.kind === "id" &&
      tokens[i + 1]?.value === "[" &&
      tokens[i + 2]?.value === t.value &&
      tokens[i + 3]?.value === "[" &&
      tokens[i + 4]?.kind === "str" &&
      tokens[i + 5]?.value === "]" &&
      tokens[i + 6]?.value === "="
    ) {
      // E[E["A"] = <init>] = "A": skip to the closing "]" and the name.
      let j = i + 7;
      let depth = 1;
      while (j < tokens.length && depth > 0) {
        const v = (tokens[j] as Token).value;
        if (v === "[" || v === "(") depth += 1;
        else if (v === "]" || v === ")") depth -= 1;
        j += 1;
      }
      if (tokens[j]?.value === "=" && tokens[j + 1]?.kind === "str") {
        i = j + 1;
        continue;
      }
    }
    const member = tokens[i + 2];
    if (
      t.kind === "id" &&
      tokens[i + 1]?.value === "." &&
      member?.kind === "id" &&
      tokens[i - 1]?.value !== "."
    ) {
      const value = values.get(`${t.value}.${member.value}`);
      if (value !== undefined) {
        out.push({ kind: "num", value: value });
        i += 2;
        continue;
      }
    }
    out.push(t);
  }
  return out;
}

/** Drop module specifier strings: a bundle hoists and dedupes imports. */
function withoutSpecifiers(tokens: Token[]): Token[] {
  return tokens.filter((t, i) => {
    if (t.kind !== "str") return true;
    const prev = tokens[i - 1];
    const prev2 = tokens[i - 2];
    if (prev?.value === "from" || prev?.value === "import") return false;
    return !(prev?.value === "(" && (prev2?.value === "require" || prev2?.value === "import"));
  });
}

function multisetDiff(a: string, b: string): string {
  const count = (text: string): Map<string, number> => {
    const m = new Map<string, number>();
    for (const item of text.split("\n")) m.set(item, (m.get(item) ?? 0) + 1);
    return m;
  };
  const ca = count(a);
  const cb = count(b);
  const out: string[] = [];
  for (const [k, v] of ca)
    if ((cb.get(k) ?? 0) !== v) out.push(`${k} bundle=${v} source=${cb.get(k) ?? 0}`);
  for (const [k, v] of cb) if (!ca.has(k)) out.push(`${k} bundle=0 source=${v}`);
  return out.slice(0, 8).join(" | ");
}

/** Whole-bundle structural comparison. esbuild does not mark every module
 * boundary (`// src/x.ts` markers are missing for some modules), so the
 * bundle is compared as one multiset against the union of all emitted
 * source modules. Imports are hoisted and deduped by the
 * bundler, so module specifiers are left out; local enum members are
 * inlined on both sides. */
function structuralCheck(
  bundleText: string,
  emitted: Map<string, string>,
): { ok: number; total: number; detail: string } {
  let union = "";
  let total = 0;
  for (const text of emitted.values()) {
    total += 1;
    union += `\n;${text}`;
  }
  if (total === 0) return { ok: 0, total: 0, detail: "no bundle module matched a source module" };
  const a = fingerprint(withoutSpecifiers(inlineEnums(normalizeEmit(tokenize(bundleText)))));
  const b = fingerprint(withoutSpecifiers(inlineEnums(normalizeEmit(tokenize(union)))));
  if (a === b) return { ok: total, total: total, detail: "" };
  if (DEBUG) process.stderr.write(`spm-debug structural: ${multisetDiff(a, b)}\n`);
  return {
    ok: 0,
    total: total,
    detail: `bundle literal/member multiset differs: ${multisetDiff(a, b)}`,
  };
}

function moduleFamily(kind: string): "cjs" | "esm" {
  return kind === "commonjs" || kind === "node16" || kind === "nodenext" ? "cjs" : "esm";
}

/** Re-emit the candidate and compare with the published JS. */
export async function reemitCheck(
  tsc: Emitter,
  pub: Published,
  srcDir: string,
  files: string[],
  ts: TsOptions,
): Promise<ContentResult> {
  const pubToSrc = new Map<string, string>();
  if (files.length === 0) {
    return { level: "unverified", checks: [], detail: "no source files", pubToSrc: pubToSrc };
  }
  const bundles = new Set<string>();
  for (const file of pub.jsFiles) {
    const text = readText(join(pub.dir, file));
    if (text !== null && isBundle(text)) bundles.add(file);
  }
  const rootTarget = pub.targets.find((t) => t.subpath === ".")?.target ?? "";
  const rootText = readText(join(pub.dir, rootTarget)) ?? "";
  const rootIsCjs =
    /\bexports\.|module\.exports|\brequire\(/.test(rootText) && !/^export /m.test(rootText);
  const configured = optionString(ts, "module");
  const modules: string[] = [];
  if (configured === "node16" || configured === "nodenext") modules.push(configured);
  modules.push(rootIsCjs ? "commonjs" : "esnext");
  modules.push(rootIsCjs ? "esnext" : "commonjs");
  const configuredTarget = optionString(ts, "target");
  const targets = configuredTarget !== "" && !ts.partial ? [configuredTarget] : FALLBACK_TARGETS;
  let best: Pairing = { pairs: [], equal: 0, firstDiff: "" };
  let bestEmit = new Map<string, string>();
  let bestDesc = "";
  let emitError = "";
  for (const moduleKind of modules) {
    for (const target of targets) {
      const result = await emit(tsc, srcDir, files, ts, moduleKind, target);
      if (result.error !== "") {
        emitError = result.error;
        continue;
      }
      if (bestEmit.size === 0) bestEmit = result.files;
      const pairing = comparePairs(result.files, pub, bundles);
      if (DEBUG) {
        process.stderr.write(
          `spm-debug ${pub.dir} ${moduleFamily(moduleKind)}/${target}: ${pairing.equal}/${pairing.pairs.length} ${pairing.firstDiff}\n`,
        );
      }
      const better =
        pairing.equal > best.equal ||
        (pairing.equal === best.equal && pairing.pairs.length > best.pairs.length);
      if (better) {
        best = pairing;
        bestEmit = result.files;
        bestDesc = `${moduleFamily(moduleKind)}/${target}`;
      }
      if (pairing.pairs.length > 0 && pairing.equal === pairing.pairs.length) break;
    }
    if (best.pairs.length > 0 && best.equal === best.pairs.length) break;
  }
  const srcOf = (emittedRel: string): string => {
    for (const f of files) {
      if (normExt(f.replace(/\.([cm]?)tsx?$/, ".$1js")) === normExt(emittedRel)) return f;
    }
    return "";
  };
  for (const [pubPath, emittedPath] of best.pairs) {
    const src = srcOf(emittedPath);
    if (src !== "") pubToSrc.set(pubPath, src);
  }
  const rootTargets = pub.targets.filter((t) => t.subpath === ".").map((t) => t.target);
  const rootCovered = best.pairs.some((p) => rootTargets.includes(p[0]));
  if (best.pairs.length > 0 && !rootCovered && !bundles.has(rootTarget)) {
    const detail = `published entry ${rootTarget} has no counterpart among ${files.length} TypeScript files (JS upstream?)`;
    return { level: "unverified", checks: [], detail: detail, pubToSrc: pubToSrc };
  }
  if (best.pairs.length > 0) {
    const checks = [`re-emit ${bestDesc} ${best.equal}/${best.pairs.length}`];
    if (best.equal === best.pairs.length) {
      return { level: "equivalent", checks: checks, detail: "", pubToSrc: pubToSrc };
    }
    // A bundle entry may still verify structurally even if a stray file differs.
    if (!bundles.has(rootTarget)) {
      return { level: "mismatch", checks: checks, detail: best.firstDiff, pubToSrc: pubToSrc };
    }
  }
  if (bundles.has(rootTarget) && bestEmit.size > 0) {
    const s = structuralCheck(rootText, bestEmit);
    const checks = [`structural bundle vs ${s.total} modules`];
    if (s.total > 0 && s.ok === s.total) {
      return { level: "structural", checks: checks, detail: "", pubToSrc: pubToSrc };
    }
    return { level: "unverified", checks: checks, detail: s.detail, pubToSrc: pubToSrc };
  }
  const detail =
    emitError !== ""
      ? `tsc emitted nothing: ${emitError}`
      : "no published module matched an emitted module";
  return { level: "unverified", checks: [], detail: detail, pubToSrc: pubToSrc };
}

// ── surface ──────────────────────────────────────────────────────────────

function resolveRelative(
  root: string,
  fromRel: string,
  spec: string,
  exts: string[],
): string | null {
  const base = normalize(join(dirname(fromRel), spec));
  const stem = base.replace(/\.([cm]?)js$/, "");
  const candidates = [base];
  for (const ext of exts) candidates.push(`${stem}${ext}`, `${base}${ext}`, `${base}/index${ext}`);
  for (const c of candidates) {
    if (!c.startsWith("..") && isFile(join(root, c)) && !c.endsWith(".js")) return c;
  }
  return null;
}

/** Exported names of `entry`, following relative `export *` chains. */
export function exportedNames(root: string, entry: string, exts: string[]): Set<string> {
  const names = new Set<string>();
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const rel = queue.shift() as string;
    if (seen.has(rel)) continue;
    seen.add(rel);
    const text = readText(join(root, rel));
    if (text === null) continue;
    const scan = exportsOf(tokenize(text));
    for (const name of scan.names) names.add(name);
    for (const star of scan.stars) {
      if (!star.startsWith(".")) {
        names.add(`*:${star}`);
        continue;
      }
      const target = resolveRelative(root, rel, star, exts);
      if (target !== null) queue.push(target);
    }
  }
  names.delete("default");
  return names;
}

export interface SurfaceResult {
  level: SurfaceLevel;
  detail: string;
}

export function surfaceCheck(pub: Published, srcDir: string, srcEntry: string): SurfaceResult {
  const dts = typesEntry(pub);
  if (dts === null) return { level: "unchecked", detail: "no published declarations" };
  const published = exportedNames(pub.dir, dts, [".d.ts", ".d.mts", ".d.cts"]);
  const source = exportedNames(srcDir, srcEntry, [".ts", ".tsx", ".mts", ".cts", ".d.ts"]);
  const missing = [...published].filter((n) => !source.has(n)).sort();
  const extra = [...source].filter((n) => !published.has(n)).sort();
  if (missing.length === 0 && extra.length === 0) return { level: "identical", detail: "" };
  const parts: string[] = [];
  if (missing.length > 0) parts.push(`missing in source: ${missing.slice(0, 5).join(", ")}`);
  if (extra.length > 0) parts.push(`extra in source: ${extra.slice(0, 5).join(", ")}`);
  return { level: "mismatch", detail: parts.join("; ") };
}

/** Write `files` (package-relative path → content) under a fresh dir. */
export function materializeFiles(dir: string, files: Map<string, string>): void {
  rmSync(dir, { recursive: true, force: true });
  for (const [rel, content] of files) {
    const dest = join(dir, rel);
    mkdirSync(dest.slice(0, dest.lastIndexOf("/")), { recursive: true });
    writeFileSync(dest, content);
  }
}

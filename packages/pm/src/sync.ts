// `spm sync`: the per-instance pipeline of DESIGN.md §5.1.
//
//   enumerate → pre-filter → locate (override, tarball, provenance, gitHead,
//   tag) → fetch tree → locate package dir → verify (content, surface,
//   closure) → policy → overlay + manifest + lock, or a fallback record.

import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Config, ContentPolicy } from "./config.js";
import type { FetchMode } from "./fetch.js";
import { fetchTree, widenTree } from "./fetch.js";
import { locateRemote } from "./locate.js";
import type {
  ContentLevel,
  Fallback,
  Identity,
  LockEntry,
  LockEvidence,
  ManifestInstance,
  Strategy,
} from "./manifest.js";
import { GENERATOR, POLICY_VERSION, writeLock, writeManifest } from "./manifest.js";
import { buildExportMap, closureProblems, materializeOverlay, resolveSource } from "./overlay.js";
import type { Instance } from "./pnpm.js";
import { enumerateInstances } from "./pnpm.js";
import type { Published } from "./published.js";
import { readPublished } from "./published.js";
import { cacheRoot, fetchVersionMeta } from "./registry.js";
import type { RepoRef } from "./repo.js";
import { importsOf, tokenize } from "./tokens.js";
import type { TsOptions } from "./tree.js";
import {
  effectiveTsconfig,
  isSourceFile,
  locatePackageDir,
  optionBool,
  sourceFilesOf,
  useDefineForClassFields,
} from "./tree.js";
import { errorMessage, isFile, pool, readText, walkFiles } from "./util.js";
import type { ContentResult, Emitter } from "./verify.js";
import {
  exactCheck,
  findTsc,
  loadCachedContent,
  materializeFiles,
  reemitCheck,
  storeCachedContent,
  surfaceCheck,
} from "./verify.js";

export interface SyncOptions {
  projectDir: string;
  config: Config;
  fetchMode: FetchMode;
  concurrency: number;
  verbose: boolean;
}

type OutcomeKind = "augmented" | "fallback" | "skipped";

interface Outcome {
  kind: OutcomeKind;
  instance: Instance;
  reason: string;
  record: ManifestInstance | null;
  lock: LockEntry | null;
  line: string;
}

interface Context {
  options: SyncOptions;
  stateDir: string;
  tsc: Emitter | null;
}

/** A located candidate source directory, before verification. */
interface Located {
  strategy: Strategy;
  identity: Identity;
  repo: string;
  commit: string;
  subdir: string;
  treeRoot: string;
  srcDir: string;
  evidence: LockEvidence;
  integrity: string;
  /** Overlay file list override (S1 takes only TS sources). */
  onlyFiles: string[] | null;
}

const OVERLAY_SKIP = new Set([
  "node_modules",
  ".git",
  "tests",
  "__tests__",
  "fixtures",
  "coverage",
  "docs",
  "examples",
  "benchmarks",
]);

const CONTENT_RANK: Record<ContentLevel, number> = {
  exact: 4,
  equivalent: 3,
  structural: 2,
  unverified: 1,
  mismatch: 0,
};

const POLICY_RANK: Record<ContentPolicy, number> = {
  exact: 4,
  equivalent: 3,
  structural: 2,
  none: 1,
};

function short(commit: string): string {
  return commit.slice(0, 7);
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function skipped(instance: Instance, reason: string): Outcome {
  return {
    kind: "skipped",
    instance: instance,
    reason: reason,
    record: null,
    lock: null,
    line: "",
  };
}

function fallback(instance: Instance, reason: string): Outcome {
  const id = `${instance.name}@${instance.version}`;
  return {
    kind: "fallback",
    instance: instance,
    reason: reason,
    record: null,
    lock: null,
    line: `fallback   ${pad(id, 46)} ${reason}`,
  };
}

/** Packages that are never augmented (DESIGN.md §5.1 pre-filter). */
function prefilter(instance: Instance, pub: Published, config: Config): string {
  if (config.exclude.includes(instance.name)) return "excluded";
  if (instance.name.startsWith("@types/") || pub.jsFiles.length === 0)
    return "types-only (no runtime JS)";
  if (
    pub.files.some((f) => f.endsWith(".node") || f === "binding.gyp" || f.startsWith("prebuilds/"))
  ) {
    return "native-addon";
  }
  const hasDts = pub.files.some((f) => /\.d\.[cm]?ts$/.test(f));
  const hasTsMaps = pub.maps.some((m) => m.sources.some((s) => /\.[cm]?tsx?$/.test(s)));
  const shipsTs = pub.files.some((f) => isSourceFile(f));
  if (!hasDts && !hasTsMaps && !shipsTs)
    return "no-ts-signal (no declarations, TS maps or TS sources shipped)";
  return "";
}

// ── S1: source shipped in the tarball ────────────────────────────────────

/** Relative runtime imports among `files` that do not resolve to a file in
 * the set: the "complete only if every module is present" rule. */
function incompleteness(root: string, files: string[]): string {
  for (const rel of files) {
    const text = readText(join(root, rel)) ?? "";
    for (const ref of importsOf(tokenize(text))) {
      if (ref.typeOnly || !ref.specifier.startsWith(".")) continue;
      if (resolveSource(root, rel, ref.specifier) === null)
        return `${rel} imports missing ${ref.specifier}`;
    }
  }
  return "";
}

function locateInTarball(instance: Instance, pub: Published, integrity: string): Located | string {
  const shipped = pub.files.filter((f) => isSourceFile(f) && !f.startsWith("node_modules/"));
  const base: Located = {
    strategy: "tarball",
    identity: "tarball",
    repo: "",
    commit: "",
    subdir: "",
    treeRoot: pub.dir,
    srcDir: pub.dir,
    evidence: { gitHead: "", provenanceCommit: "", tag: "" },
    integrity: integrity,
    onlyFiles: null,
  };
  if (shipped.length > 0) {
    const gap = incompleteness(pub.dir, shipped);
    if (gap === "") {
      base.onlyFiles = shipped;
      return base;
    }
    return `shipped .ts incomplete: ${gap}`;
  }
  const fromMaps = new Map<string, string>();
  for (const map of pub.maps) {
    for (let i = 0; i < map.sources.length; i += 1) {
      const source = map.sources[i] as string;
      const content = map.contents[i] ?? null;
      if (content === null || !isSourceFile(source)) continue;
      if (source.startsWith("..") || source.includes("node_modules/")) continue;
      fromMaps.set(source, content);
    }
  }
  if (fromMaps.size === 0) return "no TS in tarball";
  const dir = join(cacheRoot(), "tarball", instance.name, instance.version);
  materializeFiles(dir, fromMaps);
  const files = [...fromMaps.keys()].sort();
  const gap = incompleteness(dir, files);
  if (gap !== "") return `sourcesContent incomplete: ${gap}`;
  base.treeRoot = dir;
  base.srcDir = dir;
  base.onlyFiles = files;
  return base;
}

// ── remote strategies ────────────────────────────────────────────────────

async function locateSource(
  ctx: Context,
  instance: Instance,
  pub: Published,
  allowTarball: boolean,
): Promise<Located | string> {
  const config = ctx.options.config;
  const override = config.overrides[instance.name];
  const evidence: LockEvidence = { gitHead: "", provenanceCommit: "", tag: "" };
  if (override?.path !== undefined) {
    const dir = resolve(ctx.options.projectDir, override.path);
    return {
      strategy: "override",
      identity: "override",
      repo: "",
      commit: "",
      subdir: "",
      treeRoot: dir,
      srcDir: dir,
      evidence: evidence,
      integrity: "",
      onlyFiles: null,
    };
  }
  const notes: string[] = [];
  const meta = await fetchVersionMeta(instance.name, instance.version);
  if (allowTarball) {
    const tarball = locateInTarball(instance, pub, meta.integrity);
    if (typeof tarball !== "string") return tarball;
    notes.push(tarball);
  }
  const located = await locateRemote(instance.name, instance.version, meta, override);
  for (const candidate of located.candidates) {
    const result = await fetchCandidate(
      ctx,
      instance,
      candidate.repo,
      candidate.commit,
      candidate.dirHint,
    );
    if (typeof result === "string") {
      notes.push(`${candidate.strategy}: ${result}`);
      continue;
    }
    return {
      strategy: candidate.strategy,
      identity: candidate.identity,
      repo: candidate.repo.id,
      commit: candidate.commit,
      subdir: result.subdir,
      treeRoot: result.root,
      srcDir: result.subdir === "" ? result.root : join(result.root, result.subdir),
      evidence: located.evidence,
      integrity: meta.integrity,
      onlyFiles: null,
    };
  }
  for (const note of located.notes) notes.push(note);
  return `no-source: ${notes.filter((n) => n !== "no TS in tarball").join("; ") || "no candidate"}`;
}

async function fetchCandidate(
  ctx: Context,
  instance: Instance,
  repo: RepoRef,
  commit: string,
  dirHint: string,
): Promise<{ root: string; subdir: string } | string> {
  try {
    const tree = await fetchTree(repo, commit, ctx.options.fetchMode);
    const subdir = locatePackageDir(tree.root, instance.name, instance.version, dirHint);
    if (subdir === null) return `package ${instance.name} not found in ${repo.id}@${short(commit)}`;
    await widenTree(tree, subdir);
    return { root: tree.root, subdir: subdir };
  } catch (error) {
    return errorMessage(error);
  }
}

// ── verification + overlay ───────────────────────────────────────────────

function usesDecorators(srcDir: string, files: string[]): boolean {
  for (const rel of files) {
    const tokens = tokenize(readText(join(srcDir, rel)) ?? "");
    for (let i = 0; i + 1 < tokens.length; i += 1) {
      const t = tokens[i];
      const next = tokens[i + 1];
      if (t?.kind === "punct" && t.value === "@" && next?.kind === "id") return true;
    }
  }
  return false;
}

function accepted(level: ContentLevel, identity: Identity, policy: ContentPolicy): boolean {
  if (level === "mismatch") return false;
  if (identity === "override") return true;
  return CONTENT_RANK[level] >= POLICY_RANK[policy];
}

async function verifyAndMaterialize(
  ctx: Context,
  instance: Instance,
  pub: Published,
  loc: Located,
): Promise<Outcome> {
  const ts: TsOptions = effectiveTsconfig(loc.treeRoot, loc.srcDir);
  const sourceFiles = loc.onlyFiles ?? sourceFilesOf(loc.srcDir, ts);
  const where = loc.commit === "" ? loc.strategy : `${loc.repo}@${short(loc.commit)}`;
  if (sourceFiles.length === 0)
    return fallback(instance, `upstream-js: no .ts sources at ${where}`);
  // Overrides point at mutable local checkouts and are never cached.
  const cacheKey =
    loc.strategy === "override" || loc.integrity === ""
      ? ""
      : [
          POLICY_VERSION,
          instance.name,
          instance.version,
          loc.integrity,
          loc.strategy,
          loc.commit,
          loc.subdir,
        ].join("|");
  let content: ContentResult | null = cacheKey === "" ? null : loadCachedContent(cacheKey);
  if (content === null) {
    content = loc.strategy === "tarball" ? null : exactCheck(pub, loc.srcDir);
    if (content === null) {
      if (ctx.tsc === null)
        return fallback(instance, "no-emitter: no TypeScript compiler found for the content check");
      content = await reemitCheck(ctx.tsc, pub, loc.srcDir, sourceFiles, ts);
    }
    if (cacheKey !== "") storeCachedContent(cacheKey, content);
  }
  const level = content.level;
  if (level === "unverified" && content.checks.length === 0) {
    return fallback(instance, `unverifiable: ${content.detail}`);
  }
  if (level === "mismatch") {
    return fallback(instance, `content-mismatch: ${content.detail} [${content.checks.join(", ")}]`);
  }
  if (!accepted(level, loc.identity, ctx.options.config.content)) {
    const why = content.detail !== "" ? `: ${content.detail}` : "";
    return fallback(
      instance,
      `content-${level}${why} [${content.checks.join(", ")}] below policy ${ctx.options.config.content}`,
    );
  }
  const mapped = buildExportMap(pub, content.pubToSrc, loc.srcDir);
  const root = mapped.exports["."];
  if (root === undefined) {
    return fallback(
      instance,
      `entry-unmapped: ${mapped.unmapped.slice(0, 2).join(", ") || "no root export"}`,
    );
  }
  const entries = new Set<string>();
  for (const sub of Object.keys(mapped.exports)) {
    for (const file of Object.values(mapped.exports[sub] ?? {})) entries.add(file.slice(2));
  }
  const rootEntry = Object.values(root)[0]?.slice(2) ?? "";
  const surface = surfaceCheck(pub, loc.srcDir, rootEntry);
  if (surface.level === "mismatch")
    return fallback(instance, `surface-mismatch: ${surface.detail}`);
  const problems = closureProblems(loc.srcDir, instance.depsDir, [...entries]);
  if (problems.length > 0) return fallback(instance, problems[0] as string);
  const experimentalDecorators = optionBool(ts, "experimentalDecorators") ?? false;
  if (experimentalDecorators && usesDecorators(loc.srcDir, sourceFiles)) {
    return fallback(instance, "semantic-options: legacy experimentalDecorators in use");
  }
  const overlayDir = join(ctx.stateDir, "overlay", instance.instanceId, "pkg");
  const files =
    loc.onlyFiles ?? walkFiles(loc.srcDir, OVERLAY_SKIP).filter((f) => !f.endsWith(".map"));
  const srcPkg = readText(join(loc.srcDir, "package.json"));
  const srcPkgJson = srcPkg === null ? {} : (JSON.parse(srcPkg) as Record<string, unknown>);
  const typeField = srcPkgJson["type"] ?? pub.pkg["type"];
  const sourceTreeHash = materializeOverlay({
    overlayDir: overlayDir,
    srcDir: loc.srcDir,
    files: files,
    depsDir: instance.depsDir,
    name: instance.name,
    version: instance.version,
    type: typeof typeField === "string" ? typeField : "commonjs",
    exports: mapped.exports,
    imports: srcPkgJson["imports"],
  });
  const checks = [...content.checks, `surface ${surface.level}`];
  if (mapped.unmapped.length > 0) checks.push(`unmapped ${mapped.unmapped.join(", ")}`);
  if (ts.partial) checks.push("tsconfig partial");
  const useDefine = useDefineForClassFields(ts);
  if (!useDefine) checks.push("useDefineForClassFields=false (scriptc uses define semantics)");
  const record: ManifestInstance = {
    installedDir: instance.installedDir,
    name: instance.name,
    version: instance.version,
    overlayDir: overlayDir,
    exports: mapped.exports,
    publishedFormat: pub.format,
    semanticOptions: {
      useDefineForClassFields: useDefine,
      experimentalDecorators: experimentalDecorators,
      esModuleInterop: optionBool(ts, "esModuleInterop") ?? false,
    },
    source: { repo: loc.repo, commit: loc.commit, subdir: loc.subdir, strategy: loc.strategy },
    verification: { identity: loc.identity, content: level, surface: surface.level },
  };
  const lock: LockEntry = {
    integrity: loc.integrity,
    strategy: loc.strategy,
    evidence: loc.evidence,
    repo: loc.repo,
    commit: loc.commit,
    subdir: loc.subdir,
    sourceTreeHash: sourceTreeHash,
    entryMap: mapped.exports,
    verification: {
      identity: loc.identity,
      content: level,
      surface: surface.level,
      checks: checks,
    },
  };
  const id = `${instance.name}@${instance.version}`;
  const line = `augmented  ${pad(id, 46)} ${pad(where, 52)} ${pad(loc.strategy, 10)} ${level}/${surface.level}`;
  return {
    kind: "augmented",
    instance: instance,
    reason: "",
    record: record,
    lock: lock,
    line: line,
  };
}

async function processInstance(ctx: Context, instance: Instance): Promise<Outcome> {
  const started = Date.now();
  const outcome = await processInstanceUntimed(ctx, instance);
  if (process.env["SPM_DEBUG"] === "1" && outcome.kind !== "skipped") {
    process.stderr.write(
      `spm-debug time ${instance.name}@${instance.version} ${Date.now() - started}ms\n`,
    );
  }
  return outcome;
}

async function processInstanceUntimed(ctx: Context, instance: Instance): Promise<Outcome> {
  const pub = readPublished(instance.installedDir);
  const skip = prefilter(instance, pub, ctx.options.config);
  if (skip !== "") return skipped(instance, skip);
  try {
    const loc = await locateSource(ctx, instance, pub, true);
    if (typeof loc === "string") return fallback(instance, loc);
    const outcome = await verifyAndMaterialize(ctx, instance, pub, loc);
    if (outcome.kind === "augmented" || loc.strategy !== "tarball") return outcome;
    // Tarball source was found but not accepted (typically: no tsconfig, so
    // the re-emit could not reproduce the build). Try the upstream tree.
    const remote = await locateSource(ctx, instance, pub, false);
    if (typeof remote === "string") {
      return fallback(instance, `${outcome.reason}; ${remote}`);
    }
    return await verifyAndMaterialize(ctx, instance, pub, remote);
  } catch (error) {
    return fallback(instance, `error: ${errorMessage(error)}`);
  }
}

export interface SyncSummary {
  instances: number;
  candidates: number;
  augmented: number;
  fallbacks: number;
}

export async function sync(options: SyncOptions): Promise<SyncSummary> {
  const started = Date.now();
  const stateDir = join(options.projectDir, ".scriptc-pm");
  const instances = enumerateInstances(options.projectDir);
  const ctx: Context = { options: options, stateDir: stateDir, tsc: findTsc(options.projectDir) };
  rmSync(join(stateDir, "overlay"), { recursive: true, force: true });
  mkdirSync(stateDir, { recursive: true });
  const outcomes = await pool(instances, options.concurrency, (instance) =>
    processInstance(ctx, instance),
  );
  // MVP (DESIGN.md §5.6.3): only names with one augmented instance are
  // redirected; the rest compile from published JS.
  const augmentedByName = new Map<string, number>();
  for (const o of outcomes) {
    if (o.kind === "augmented")
      augmentedByName.set(o.instance.name, (augmentedByName.get(o.instance.name) ?? 0) + 1);
  }
  const instancesOut: ManifestInstance[] = [];
  const fallbacks: Fallback[] = [];
  const lockEntries: Record<string, LockEntry> = {};
  let candidates = 0;
  for (const o of outcomes) {
    const instance = o.instance;
    if (o.kind !== "skipped") candidates += 1;
    if (o.kind === "augmented" && o.record !== null && o.lock !== null) {
      const count = augmentedByName.get(instance.name) ?? 0;
      if (count > 1) {
        const reason = `ambiguous-name: ${count} augmented instances of ${instance.name}`;
        fallbacks.push({ name: instance.name, version: instance.version, reason: reason });
        process.stdout.write(`${fallback(instance, reason).line}\n`);
        rmSync(join(stateDir, "overlay", instance.instanceId), { recursive: true, force: true });
        continue;
      }
      instancesOut.push(o.record);
      lockEntries[`${instance.name}@${instance.version}`] = o.lock;
      process.stdout.write(`${o.line}\n`);
      continue;
    }
    const reason = o.kind === "skipped" ? `not-candidate: ${o.reason}` : o.reason;
    fallbacks.push({ name: instance.name, version: instance.version, reason: reason });
    if (o.kind === "fallback" || options.verbose) {
      process.stdout.write(`${o.kind === "fallback" ? o.line : fallback(instance, reason).line}\n`);
    }
  }
  const lockDigest = writeLock(options.projectDir, lockEntries);
  writeManifest(stateDir, {
    schema: 1,
    generator: GENERATOR,
    lockDigest: lockDigest,
    instances: instancesOut,
    fallbacks: fallbacks,
  });
  warnIfNotIgnored(options.projectDir);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  process.stdout.write(
    `spm: ${instances.length} instances, ${candidates} source candidates, ${instancesOut.length} augmented, ` +
      `${candidates - instancesOut.length} fallback (${seconds}s)\n`,
  );
  process.stdout.write(`wrote .scriptc-pm/manifest.json, scriptc-sources.lock.json\n`);
  return {
    instances: instances.length,
    candidates: candidates,
    augmented: instancesOut.length,
    fallbacks: candidates - instancesOut.length,
  };
}

function warnIfNotIgnored(projectDir: string): void {
  const gitignore = readText(join(projectDir, ".gitignore"));
  if (
    !isFile(join(projectDir, ".gitignore")) ||
    gitignore === null ||
    !gitignore.includes(".scriptc-pm")
  ) {
    process.stderr.write(
      "spm: warning: .scriptc-pm/ is not in .gitignore (overlays may contain private source)\n",
    );
  }
}

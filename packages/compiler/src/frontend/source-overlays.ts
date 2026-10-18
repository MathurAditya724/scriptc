/* Source overlays: TypeScript source trees that replace installed npm
 * packages' published JavaScript (`scriptc build --sources`).
 *
 * A package manager (scriptc-pm) materializes each augmented package
 * instance's upstream source into an overlay directory and describes the
 * set in `.scriptc-pm/manifest.json`. The compiler never fetches or
 * verifies anything: it reads the manifest, keys every instance by the
 * REALPATH of its installed directory (so two installed versions of one
 * name are distinct instances), and the resolver redirects bare imports
 * that land in an instance's installed directory to the instance's
 * `exports` inside its overlay directory (resolve.ts,
 * resolveSourceOverlayModule). Overlay files live outside node_modules, so
 * they compile as program modules.
 *
 * Every instance can fall back: the frontend drops an instance's redirect
 * (pipeline.ts) when its source fails preflight or lowering, when a
 * require() edge targets it, or when the checker and the resolver could
 * disagree about it. The package then compiles from its published JS
 * exactly as it would without --sources. Drops reset per compile. */

import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

/** One augmented package instance, as the compiler uses it. */
export interface SourceOverlayInstance {
  /** realpath(installedDir): the instance identity. */
  key: string;
  name: string;
  version: string;
  /** realpath(overlayDir), without a trailing slash. */
  overlayDir: string;
  /** package.json-shaped "exports" resolved against overlayDir. */
  exports: unknown;
  /** Human-readable source origin for reports ("github.com/o/r @ abc123"),
   * or null when the producer did not say. */
  origin: string | null;
  /** The package's own ambient declaration files (realpaths inside
   * overlayDir) that its build includes without importing them, e.g.
   * module augmentations under `typings/`. They join the checker's roots
   * while the instance is active. */
  ambientDeclarations?: string[];
  /** "assign" when the package was built with `useDefineForClassFields:
   * false`: its class field initializers are assignments that run after
   * the parameter properties (class-field lowering, preflight). */
  classFields?: "assign";
}

/** A complete overlay set, ready to install for a compile. */
export interface SourceOverlaySet {
  /** Where the set came from (a manifest path, or "--provenance-sources"). */
  origin: string;
  /** Build-cache identity for the set, or null when the set cannot be
   * cached (the network-fetching --provenance-sources pilot). */
  cacheIdentity: string | null;
  instances: SourceOverlayInstance[];
  /** Producer notes (manifest fallbacks, skipped instances). */
  notes: string[];
}

/** The per-package lines of the coverage report's source section. */
export interface SourceOverlayReport {
  origin: string;
  packages: {
    /** The instance key (realpath of its installed directory). */
    key: string;
    name: string;
    version: string;
    dir: string;
    origin: string | null;
    /** Null when the overlay compiled; the reason otherwise. */
    fallback: string | null;
  }[];
  notes: string[];
}

export const SOURCE_MANIFEST_RELATIVE_PATH = ".scriptc-pm/manifest.json";

interface OverlayState {
  set: SourceOverlaySet;
  byKey: Map<string, SourceOverlayInstance>;
  /** Install-time drops (ambiguous names) — the starting point of every
   * compile's drop set. */
  initialDrops: Map<string, string>;
  drops: Map<string, string>;
  /** Problems the resolver noticed while answering (missing export
   * targets, checker disagreement), drained by the frontend loop. */
  problems: Map<string, string>;
}

let state: OverlayState | null = null;

/** Installs `set` for the following compiles; null clears it. Names with
 * more than one augmented instance cannot be redirected for the checker
 * until it resolves per instance (tsgo receives one global `paths` entry
 * per name), so those instances start dropped. */
export function installSourceOverlays(set: SourceOverlaySet | null): void {
  if (set === null) {
    state = null;
    return;
  }
  const byKey = new Map<string, SourceOverlayInstance>();
  const byName = new Map<string, SourceOverlayInstance[]>();
  for (const instance of set.instances) {
    byKey.set(instance.key, instance);
    const list = byName.get(instance.name) ?? [];
    list.push(instance);
    byName.set(instance.name, list);
  }
  const initialDrops = new Map<string, string>();
  for (const [name, list] of byName) {
    if (list.length < 2) continue;
    for (const instance of list) {
      initialDrops.set(
        instance.key,
        `ambiguous-name: ${list.length} augmented instances of ${name} (only single-instance names are redirected)`,
      );
    }
  }
  state = { set, byKey, initialDrops, drops: new Map(initialDrops), problems: new Map() };
}

/** Restores the install-time drop set; called once per compile, before
 * the first program load. */
export function beginSourceOverlayCompile(): void {
  if (state === null) return;
  state.drops = new Map(state.initialDrops);
  state.problems.clear();
}

export function sourceOverlaySet(): SourceOverlaySet | null {
  return state?.set ?? null;
}

/** True when at least one instance is currently redirected. */
export function sourceOverlaysActive(): boolean {
  return state !== null && state.drops.size < state.byKey.size;
}

/** The redirected (not dropped) instances. */
export function activeSourceOverlays(): SourceOverlayInstance[] {
  if (state === null) return [];
  const s = state;
  return s.set.instances.filter((instance) => !s.drops.has(instance.key));
}

/** True when some active instance is named `name` — the cheap pre-check
 * before the resolver walks node_modules. */
export function sourceOverlayNameActive(name: string): boolean {
  if (state === null) return false;
  for (const instance of state.set.instances) {
    if (instance.name === name && !state.drops.has(instance.key)) return true;
  }
  return false;
}

/** The active instance whose installed directory realpaths to `realDir`. */
export function activeSourceOverlayAt(realDir: string): SourceOverlayInstance | null {
  const instance = state?.byKey.get(realDir);
  return instance !== undefined && !state!.drops.has(instance.key) ? instance : null;
}

/** The instance (active or dropped) whose overlay directory contains
 * `file`, or null. */
export function sourceOverlayOfFile(file: string): SourceOverlayInstance | null {
  if (state === null) return null;
  const norm = file.split("\\").join("/");
  for (const instance of state.set.instances) {
    const dir = instance.overlayDir;
    if (norm.startsWith(dir) && norm[dir.length] === "/") return instance;
  }
  return null;
}

/** True when `file` belongs to an active overlay — the gate for the
 * third-party-source lowering policies (the @__PURE__ dead-const elision,
 * per-file statement attribution). */
export function isSourceOverlayFile(file: string): boolean {
  const instance = sourceOverlayOfFile(file);
  return instance !== null && !state!.drops.has(instance.key);
}

/** True when `file` belongs to an active overlay built with
 * `useDefineForClassFields: false` — the gate for assign-semantics class
 * fields. False without --sources. */
export function sourceOverlayAssignsClassFields(file: string): boolean {
  if (state === null) return false;
  const instance = sourceOverlayOfFile(file);
  return instance?.classFields === "assign" && !state.drops.has(instance.key);
}

/** The active instances' ambient declaration files, for the checker's
 * roots; empty without --sources. */
export function activeSourceOverlayAmbientRoots(): string[] {
  if (state === null) return [];
  const roots: string[] = [];
  for (const instance of activeSourceOverlays()) {
    for (const file of instance.ambientDeclarations ?? []) roots.push(file);
  }
  return roots;
}

export function dropSourceOverlay(key: string, reason: string): void {
  if (state === null || !state.byKey.has(key) || state.drops.has(key)) return;
  state.drops.set(key, reason);
}

/** The current drop set, for a probe that may need to undo its drops. */
export function snapshotSourceOverlayDrops(): Map<string, string> {
  return new Map(state?.drops ?? []);
}

export function restoreSourceOverlayDrops(snapshot: ReadonlyMap<string, string>): void {
  if (state !== null) state.drops = new Map(snapshot);
}

export function noteSourceOverlayProblem(key: string, reason: string): void {
  if (state === null || state.drops.has(key) || state.problems.has(key)) return;
  state.problems.set(key, reason);
}

/** Drains the problems the resolver noted since the last call. */
export function takeSourceOverlayProblems(): Map<string, string> {
  if (state === null) return new Map();
  const out = new Map(state.problems);
  state.problems.clear();
  return out;
}

export function sourceOverlayDropReason(key: string): string | null {
  return state?.drops.get(key) ?? null;
}

/** The instances the last compile dropped, with their reasons. */
export function sourceOverlayFallbacks(): { name: string; version: string; reason: string }[] {
  if (state === null) return [];
  const out: { name: string; version: string; reason: string }[] = [];
  for (const instance of state.set.instances) {
    const reason = state.drops.get(instance.key);
    if (reason !== undefined) out.push({ name: instance.name, version: instance.version, reason });
  }
  return out;
}

/** The build-cache identity: undefined when no set is installed, null when
 * the installed set cannot be cached. */
export function sourceOverlayCacheIdentity(): string | null | undefined {
  if (state === null) return undefined;
  return state.set.cacheIdentity;
}

/** Report rows: every instance the program reached (`used` holds the keys
 * of active instances with files in the final program) plus every dropped
 * instance, in manifest order. */
export function sourceOverlayReport(used: ReadonlySet<string>): SourceOverlayReport | null {
  if (state === null) return null;
  const packages: SourceOverlayReport["packages"] = [];
  for (const instance of state.set.instances) {
    const dropped = state.drops.get(instance.key);
    // Ambiguous-name drops are reported even when unused: they explain
    // why an augmented package compiled from its published JS.
    if (dropped === undefined && !used.has(instance.key)) continue;
    packages.push({
      key: instance.key,
      name: instance.name,
      version: instance.version,
      dir: instance.overlayDir,
      origin: instance.origin,
      fallback: dropped ?? null,
    });
  }
  return { origin: state.set.origin, packages, notes: state.set.notes };
}

/* ── the manifest (schema 1) ──────────────────────────────────────────── */

/** Walks up from the entry's directory to the nearest
 * `.scriptc-pm/manifest.json`. */
export function findSourceManifest(entryPath: string): string | null {
  for (let dir = dirname(resolve(entryPath)); ;) {
    const candidate = join(dir, SOURCE_MANIFEST_RELATIVE_PATH);
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      /* keep walking */
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function realDirectory(path: string): string | null {
  try {
    const real = realpathSync(path);
    return statSync(real).isDirectory() ? real.split("\\").join("/").replace(/\/+$/, "") : null;
  } catch {
    return null;
  }
}

function originOf(source: unknown): string | null {
  if (source === null || typeof source !== "object") return null;
  const s = source as { repo?: unknown; commit?: unknown; subdir?: unknown };
  if (typeof s.repo !== "string") return null;
  const commit = typeof s.commit === "string" ? ` @ ${s.commit.slice(0, 12)}` : "";
  const subdir = typeof s.subdir === "string" && s.subdir !== "" ? ` (${s.subdir})` : "";
  return `${s.repo}${commit}${subdir}`;
}

/** An instance's `ambientDeclarations`: declaration files relative to its
 * overlay directory, which must stay inside it. Returns realpaths, or the
 * first entry that does not exist. */
function ambientDeclarationsOf(
  raw: unknown,
  overlayDir: string,
  bad: (what: string) => Error,
): string[] | { missing: string } {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw bad("must be an array of relative paths");
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string" || entry === "" || isAbsolute(entry)) {
      throw bad("must be an array of relative paths");
    }
    if (!/\.d\.(?:ts|mts|cts)$/.test(entry)) throw bad(`entry ${entry} is not a declaration file`);
    let real: string;
    try {
      real = realpathSync(join(overlayDir, entry)).split("\\").join("/");
    } catch {
      return { missing: entry };
    }
    if (!real.startsWith(`${overlayDir}/`)) throw bad(`entry ${entry} leaves the overlay`);
    if (!out.includes(real)) out.push(real);
  }
  return out;
}

/** Reads and validates a schema-1 manifest. Throws an Error naming the
 * first problem for an unreadable or malformed manifest; instances whose
 * directories are missing are skipped with a note (they compile from
 * published JS). */
export function loadSourceManifest(manifestPath: string): SourceOverlaySet {
  const path = resolve(manifestPath);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new Error(`cannot read source manifest ${path}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(
      `source manifest ${path} is not valid JSON (${e instanceof Error ? e.message : String(e)})`,
    );
  }
  const bad = (what: string): Error => new Error(`source manifest ${path}: ${what}`);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw bad("expected a JSON object");
  }
  const doc = raw as Record<string, unknown>;
  if (doc["schema"] !== 1) {
    throw bad(`unsupported schema ${JSON.stringify(doc["schema"])} (this scriptc reads schema 1)`);
  }
  const lockDigest = doc["lockDigest"];
  if (typeof lockDigest !== "string" || lockDigest === "") {
    throw bad("missing lockDigest");
  }
  const rawInstances = doc["instances"];
  if (!Array.isArray(rawInstances)) throw bad("missing instances array");
  const instances: SourceOverlayInstance[] = [];
  const notes: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < rawInstances.length; index++) {
    const entry: unknown = rawInstances[index];
    if (entry === null || typeof entry !== "object")
      throw bad(`instances[${index}] is not an object`);
    const e = entry as Record<string, unknown>;
    for (const field of ["installedDir", "name", "version", "overlayDir"]) {
      if (typeof e[field] !== "string" || e[field] === "") {
        throw bad(`instances[${index}].${field} must be a non-empty string`);
      }
    }
    const installedDir = e["installedDir"] as string;
    const overlayDir = e["overlayDir"] as string;
    const name = e["name"] as string;
    const version = e["version"] as string;
    if (!isAbsolute(installedDir) || !isAbsolute(overlayDir)) {
      throw bad(`instances[${index}] directories must be absolute paths`);
    }
    const exportsField = e["exports"];
    if (
      exportsField === undefined ||
      exportsField === null ||
      (typeof exportsField !== "string" && typeof exportsField !== "object")
    ) {
      throw bad(`instances[${index}].exports must be a string or an object`);
    }
    const key = realDirectory(installedDir);
    if (key === null) {
      notes.push(`${name}@${version}: installed directory ${installedDir} does not exist; skipped`);
      continue;
    }
    const realOverlay = realDirectory(overlayDir);
    if (realOverlay === null) {
      notes.push(`${name}@${version}: overlay directory ${overlayDir} does not exist; skipped`);
      continue;
    }
    if (seen.has(key)) throw bad(`instances[${index}] repeats installed directory ${key}`);
    seen.add(key);
    // Additive schema-1 fields: absent means the historical behavior.
    const semantic = e["semanticOptions"];
    if (semantic !== undefined && (semantic === null || typeof semantic !== "object")) {
      throw bad(`instances[${index}].semanticOptions must be an object`);
    }
    const useDefine = (semantic as Record<string, unknown> | undefined)?.[
      "useDefineForClassFields"
    ];
    if (useDefine !== undefined && typeof useDefine !== "boolean") {
      throw bad(`instances[${index}].semanticOptions.useDefineForClassFields must be a boolean`);
    }
    const ambient = ambientDeclarationsOf(e["ambientDeclarations"], realOverlay, (what) =>
      bad(`instances[${index}].ambientDeclarations ${what}`),
    );
    if (!Array.isArray(ambient)) {
      notes.push(
        `${name}@${version}: ambient declaration ${ambient.missing} does not exist in the overlay; skipped`,
      );
      continue;
    }
    instances.push({
      key,
      name,
      version,
      overlayDir: realOverlay,
      exports: exportsField,
      origin: originOf(e["source"]),
      ...(ambient.length > 0 ? { ambientDeclarations: ambient } : {}),
      ...(useDefine === false ? { classFields: "assign" as const } : {}),
    });
  }
  const fallbacks = doc["fallbacks"];
  if (Array.isArray(fallbacks)) {
    for (const f of fallbacks) {
      if (f === null || typeof f !== "object") continue;
      const fb = f as { name?: unknown; version?: unknown; reason?: unknown };
      if (typeof fb.name !== "string") continue;
      const version = typeof fb.version === "string" ? `@${fb.version}` : "";
      const reason = typeof fb.reason === "string" ? fb.reason : "no reason given";
      notes.push(`${fb.name}${version}: published JS (${reason})`);
    }
  }
  // The lock digest names the dependency and source state the manifest was
  // generated from; the bytes digest also covers hand-edited manifests.
  const cacheIdentity = `${lockDigest}\0${createHash("sha256").update(text).digest("hex")}`;
  return { origin: path, cacheIdentity, instances, notes };
}

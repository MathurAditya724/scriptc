/** Shared frontend orchestration. Hosts supply a program loader so Node
 * and native callers use the same npm selection, preflight and lowering. */
import type { ScrDiagnostic } from "../diagnostics/diagnostic.js";
import type { SrcLoc } from "../ir/ir.js";
import type { NpmStaticStatus } from "../coverage/report.js";
import { entryFunctionExports, type EntryExportInfo } from "./lib-exports.js";
import { entryContractFacts, type ContractFacts } from "./lib-contract.js";
import {
  canonicalBuiltinModule,
  checkPreflight,
  isNodeTypesPath,
  locOf,
  requiresOf,
  resolveNpmImport,
  type LoadResult,
} from "./program.js";
import {
  npmStaticIneligibleReason,
  npmStaticOffenders,
  npmStaticPackageOfPath,
} from "./npm-static.js";
import {
  clearResolveCaches,
  resolveBareModule,
  resolveSourceOverlayModule,
  resolveWorkspaceSourceModule,
} from "./resolve.js";
import {
  activeSourceOverlays,
  beginSourceOverlayCompile,
  dropSourceOverlay,
  isSourceOverlayFile,
  restoreSourceOverlayDrops,
  snapshotSourceOverlayDrops,
  sourceOverlayDropReason,
  sourceOverlayOfFile,
  sourceOverlayReport,
  sourceOverlaySet,
  sourceOverlaysActive,
  takeSourceOverlayProblems,
  type SourceOverlayReport,
} from "./source-overlays.js";
import { npmStaticRefusalDiag } from "../diagnostics/diagnostic.js";
import { isJsSourceFileName } from "./tsc-codes.js";
import { isRelativeSpecifier, packageNameOfSpecifier } from "./workspace-registry.js";
import { lowerToIr, type LowerOptions, type LowerResult } from "./lowering/lowerer.js";
import type { FrontendServices } from "./services.js";
import { isImportDeclaration, isExportDeclaration, isStringLiteral } from "./ts7/adapter.js";
import { CONTRACT_TYPES_MODULE } from "./contract-types.js";
import { THREADS_MODULE } from "./threads-import.js";
import { EXPERIMENTAL_MODULE } from "./experimental-import.js";

export interface ProgramLoadOptions {
  npmStatic?: readonly string[];
  externalTypes?: Readonly<Record<string, string>> | undefined;
}

/** A load owns its program resources until LoadResult.dispose(). Host
 * transports may own additional resources around the whole frontend. */
export type ProgramLoader = (
  entryPath: string,
  options: ProgramLoadOptions,
) => LoadResult & {
  services: FrontendServices;
  dispose: () => void;
};

/* ── the frontend, one pipeline shape ───────────────────────────────────
 * Load → preflight → lowering all ride the ONE tsgo program (program.ts +
 * lowering/ over the ts7 adapter) — the native TypeScript compiler is the
 * only frontend since the phase-4 flip retired the 5.9.3 pipeline
 * (typescript@5.9.3 survives solely behind the source-string parser and
 * transpilation islands enforced by scripts/test-ts7.mjs). Everything after
 * lowering is IR-world, so analyze() and compile() consume this one
 * Frontend shape. */
export interface Frontend {
  preflight: ScrDiagnostic[];
  /** The entry source file's text for diagnostics and source annotations. */
  entryText: () => string;
  /** Library mode's resolution input: the entry file's exported function
   * declarations (call before dispose — it reads the ts7 AST). */
  entryExports: () => Map<string, EntryExportInfo>;
  /** The contract sidecar's projection input: the entry file's exported
   * function signatures and convention consts, plus the whole graph's
   * exported type declarations, in declaration order (call before
   * dispose — it reads the ts7 AST). */
  entryContract: () => ContractFacts;
  sourceTexts: () => Map<string, string>;
  lower: (opts: LowerOptions) => LowerResult;
  /** Each requested or detected package's native compilation outcome,
   * including the first refusal reason for ineligible packages. */
  npmStatic: NpmStaticStatus[];
  /** Each judged npm package's first import site, used to anchor refusals. */
  npmImportSites: ReadonlyMap<string, SrcLoc>;
  /** --sources: the overlay instances the final program compiles from
   * source, and every instance that fell back to published JS. */
  sourceOverlays: () => SourceOverlayReport | null;
  /** Releases the frontend's resources (the spawned tsgo server). Call
   * exactly once, after the last lower(). */
  dispose: () => void;
}

/** Hosts own transport lifetimes; shared compiler stages own the frontend. */
export type FrontendFactory = (
  entryPath: string,
  npmStatic?: readonly string[] | "auto" | "lib",
  externalTypes?: Readonly<Record<string, string>>,
  libraryNpmStatic?: readonly string[],
) => Frontend;

function detectAutoPackages(
  load: LoadResult,
  statuses: NpmStaticStatus[],
  mode: "auto" | "lib" = "auto",
  judged?: Set<string>,
  sites?: Map<string, SrcLoc>,
): string[] {
  // package → the resolved types file AND the file whose import found it:
  // the runtime-JS probe below must resolve from the SAME importing file,
  // or a package visible only to a nested package.json realm (a pnpm
  // monorepo's packages/*/node_modules, unreachable from the entry's own
  // walk-up) answers "no runtime JS" for perfectly ordinary installs.
  const seen = new Map<string, { typesFile: string; fromFile: string; spec: string }>();
  for (const sf of [...load.moduleOrder, load.entry]) {
    if (mode === "auto" && sf.fileName.includes("/node_modules/")) continue;
    const edges: { spec: string; loc: SrcLoc }[] = [];
    for (const stmt of sf.statements) {
      if (
        (isImportDeclaration(stmt) || isExportDeclaration(stmt)) &&
        stmt.moduleSpecifier &&
        isStringLiteral(stmt.moduleSpecifier)
      ) {
        edges.push({ spec: stmt.moduleSpecifier.text, loc: locOf(stmt) });
      } else if (mode === "lib") {
        // CJS packages spell their dep edges as top-level requires; the
        // import-statement scan alone would miss every one of them.
        for (const req of requiresOf(stmt)) edges.push({ spec: req.spec, loc: locOf(req.node) });
      }
    }
    for (const { spec, loc } of edges) {
      if (load.externalTypes?.has(spec)) continue;
      // scriptc's own packages are not npm dependencies: contract types are
      // declarations only, and @scriptc/threads and @scriptc/experimental
      // exports lower at their use sites (threads-import.ts,
      // experimental-import.ts), typed by their declarations.
      if (spec === CONTRACT_TYPES_MODULE || spec === THREADS_MODULE || spec === EXPERIMENTAL_MODULE)
        continue;
      // Augmented instances resolve to program sources, so the published
      // package's declaration eligibility does not apply.
      if (resolveSourceOverlayModule(sf.fileName, spec) !== null) continue;
      if (resolveWorkspaceSourceModule(sf.fileName, spec) !== null) continue;
      if (isRelativeSpecifier(spec) || spec.startsWith("node:") || spec.startsWith("#")) continue;
      // Bare builtin names ("fs", "path") are the builtin machinery's
      // business (and the SC4005 async_free gate's, in library mode) —
      // never npm candidates. Auto keeps its original path (the
      // @types/node answer skips them below), unchanged.
      if (mode === "lib" && canonicalBuiltinModule(spec) !== null) continue;
      // Explicit attempts name the runtime package. Types-first resolution
      // may instead identify its @types twin, which has no runtime to admit.
      if (judged?.has(packageNameOfSpecifier(spec))) continue;
      const npm = resolveNpmImport(sf.fileName, spec);
      if (npm !== null && isNodeTypesPath(npm.typesFile)) continue;
      if (npm === null) {
        if (mode !== "lib") continue;
        const js = resolveBareModule(sf.fileName, spec, "js-only");
        if (js === null || judged!.has(js.packageName)) continue;
        judged!.add(js.packageName);
        sites!.set(js.packageName, loc);
        statuses.push({
          package: js.packageName,
          status: "refused",
          detail: "it ships no own .d.ts declaration surface",
        });
        continue;
      }
      if (judged?.has(npm.packageName)) continue;
      if (!seen.has(npm.packageName)) {
        seen.set(npm.packageName, { typesFile: npm.typesFile, fromFile: sf.fileName, spec });
        sites?.set(npm.packageName, loc);
      }
    }
  }
  const chosen: string[] = [];
  for (const [pkg, { typesFile, fromFile, spec }] of seen) {
    judged?.add(pkg);
    // A package without a root entry (no "main", "exports" or index file)
    // can still serve the subpath the program imports.
    const jsEntry =
      resolveBareModule(fromFile, pkg, "js-only") ?? resolveBareModule(fromFile, spec, "js-only");
    const reason = npmStaticIneligibleReason(
      pkg,
      typesFile,
      jsEntry !== null && isJsSourceFileName(jsEntry.typesFile) ? jsEntry.typesFile : null,
    );
    if (reason === null) chosen.push(pkg);
    else
      statuses.push({
        package: pkg,
        status: "refused",
        detail: mode === "lib" ? reason : `auto: ${reason}`,
      });
  }
  return chosen;
}

/** The opted-in packages a consumer-anchored tsc message NAMES: module
 * specifiers in `Module '"spec"'` phrasings, and resolved file paths in
 * `import("…")` type spellings — the two ways the checker points at an
 * import surface from the importer's side. */
function packagesNamedByDiag(message: string, optedIn: ReadonlySet<string>): Set<string> {
  const hits = new Set<string>();
  for (const m of message.matchAll(/Module '"([^"]+)"'/g)) {
    const spec = m[1]!;
    const prefix = packageNameOfSpecifier(spec);
    if (optedIn.has(prefix)) hits.add(prefix);
  }
  for (const m of message.matchAll(/import\("([^"]+)"\)/g)) {
    const pkg = npmStaticPackageOfPath(m[1]!);
    if (pkg !== null && optedIn.has(pkg)) hits.add(pkg);
  }
  return hits;
}

/** Where a diagnostic sits, relative to its overlay ("src/x.ts:12"). */
function overlaySite(
  file: string,
  overlayDir: string,
  text: string | undefined,
  start: number,
): string {
  const rel = file.slice(overlayDir.length + 1);
  if (text === undefined) return rel;
  let line = 1;
  for (let i = 0; i < start && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return `${rel}:${line}`;
}

/** --sources: the active overlay instances a load implicates, each with the
 * first reason. An instance falls back to published JS when its source
 * fails preflight (any diagnostic anchored in an overlay file — module-form
 * refusals and type errors alike), when a program type error names its
 * specifier or files, when a top-level require() edge targets it (the
 * CommonJS shape of a published package is not synthesized for source),
 * or when the resolver noted a checker disagreement. */
function sourceOverlayCulprits(
  load: LoadResult,
  preflight: readonly ScrDiagnostic[],
): Map<string, string> {
  const culprits = takeSourceOverlayProblems();
  if (!sourceOverlaysActive()) return culprits;
  const add = (key: string, reason: string): void => {
    if (!culprits.has(key)) culprits.set(key, reason);
  };
  const texts = new Map<string, string>();
  for (const sf of [load.entry, ...load.moduleOrder]) texts.set(sf.fileName, sf.text);
  const active = activeSourceOverlays();
  for (const d of preflight) {
    const owner = sourceOverlayOfFile(d.loc.file);
    if (owner !== null && isSourceOverlayFile(d.loc.file)) {
      const site = overlaySite(d.loc.file, owner.overlayDir, texts.get(d.loc.file), d.loc.start);
      add(owner.key, `${d.code} at ${site}: ${d.message}`);
      continue;
    }
    if (d.code !== "SC0001") continue;
    for (const instance of active) {
      const named =
        d.message.includes(`'"${instance.name}"'`) ||
        d.message.includes(`'"${instance.name}/`) ||
        d.message.includes(`${instance.overlayDir}/`);
      if (named)
        add(instance.key, `the program does not typecheck against its source: ${d.message}`);
    }
  }
  for (const sf of [load.entry, ...load.moduleOrder]) {
    for (const stmt of sf.statements) {
      for (const req of requiresOf(stmt)) {
        const target = resolveSourceOverlayModule(sf.fileName, req.spec, "require");
        const owner = target === null ? null : sourceOverlayOfFile(target);
        if (owner === null) continue;
        add(
          owner.key,
          `require() of '${req.spec}' from ${sf.fileName} (CommonJS interop for source overlays is not implemented)`,
        );
      }
    }
  }
  for (const [key, reason] of takeSourceOverlayProblems()) add(key, reason);
  return culprits;
}

function dropSourceOverlays(culprits: ReadonlyMap<string, string>): void {
  for (const [key, reason] of culprits) dropSourceOverlay(key, reason);
}

/** The first diagnostic outside every overlay, as a one-line reason. */
function surfaceReason(verb: string, diagnostics: readonly ScrDiagnostic[]): string {
  const d = diagnostics.find((x) => sourceOverlayOfFile(x.loc.file) === null) ?? diagnostics[0]!;
  return `the program does not ${verb} against its source surface (${d.code} in ${d.loc.file}: ${d.message.split("\n")[0]})`;
}

/** The keys of the overlays a frontend compiles from source. */
function frontendOverlayKeys(fe: Frontend): string[] {
  return (fe.sourceOverlays()?.packages ?? []).filter((p) => p.fallback === null).map((p) => p.key);
}

/** The keys of active instances with files in the program. */
function usedSourceOverlays(load: LoadResult): Set<string> {
  const used = new Set<string>();
  if (!sourceOverlaysActive()) return used;
  for (const sf of load.program.getImplementationSourceFiles()) {
    const owner = sourceOverlayOfFile(sf.fileName);
    if (owner !== null && isSourceOverlayFile(sf.fileName)) used.add(owner.key);
  }
  return used;
}

/** True when a reloaded frontend can be lowered at all: a clean preflight
 * and no refused package (executable and library builds stop on both). */
function frontendLowerable(fe: Frontend, coverage: boolean): boolean {
  return (
    fe.preflight.length === 0 &&
    (coverage || !fe.npmStatic.some((entry) => entry.status === "refused"))
  );
}

/** --sources: lowering can still refuse a statement after preflight
 * passed. A refusal inside an overlay drops that instance; a failure
 * outside every overlay probes the published surface with every used
 * overlay dropped (the program may only fail against a declared source
 * type the published JS's inferred surface avoids) and keeps the probe
 * only when it lowers cleanly. Each fallback reloads the frontend, so the
 * dropped packages resolve to their published JS. The arrays and maps
 * callers read are refreshed in place, so copies of the wrapper observe
 * the reload too. */
function withSourceOverlayLoweringFallback(
  first: Frontend,
  reload: () => Frontend,
  entryPath: string,
): Frontend {
  let current = first;
  const adopt = (next: Frontend): void => {
    current.dispose();
    current = next;
    fe.preflight.splice(0, fe.preflight.length, ...next.preflight);
    fe.npmStatic.splice(0, fe.npmStatic.length, ...next.npmStatic);
    const sites = fe.npmImportSites as Map<string, SrcLoc>;
    sites.clear();
    for (const [k, v] of next.npmImportSites) sites.set(k, v);
  };
  /** The failure a reload that cannot be lowered reports, shaped like the
   * checks executable and library builds run before lowering. */
  const unlowerable = (stats: LowerResult["stats"], coverage: boolean): LowerResult => ({
    module: null,
    diagnostics: [
      ...current.preflight,
      ...(coverage ? [] : current.npmStatic)
        .filter((entry) => entry.status === "refused")
        .map((entry) =>
          npmStaticRefusalDiag(
            entry.package,
            entry.detail ?? "its static compilation was refused",
            current.npmImportSites.get(entry.package) ?? { file: entryPath, start: 0, end: 0 },
          ),
        ),
    ],
    runtimeFences: [],
    stats,
  });
  const fe: Frontend = {
    preflight: [...first.preflight],
    npmStatic: [...first.npmStatic],
    npmImportSites: new Map(first.npmImportSites),
    entryText: () => current.entryText(),
    entryExports: () => current.entryExports(),
    entryContract: () => current.entryContract(),
    sourceTexts: () => current.sourceTexts(),
    sourceOverlays: () => current.sourceOverlays(),
    dispose: () => current.dispose(),
    lower: (opts) => {
      const coverage = opts.coverage === true;
      for (;;) {
        const result = current.lower(opts);
        const culprits = new Map<string, string>();
        let texts: Map<string, string> | null = null;
        for (const d of result.diagnostics) {
          const owner = sourceOverlayOfFile(d.loc.file);
          if (owner === null || !isSourceOverlayFile(d.loc.file) || culprits.has(owner.key))
            continue;
          texts ??= current.sourceTexts();
          const site = overlaySite(
            d.loc.file,
            owner.overlayDir,
            texts.get(d.loc.file),
            d.loc.start,
          );
          culprits.set(owner.key, `${d.code} at ${site}: ${d.message}`);
        }
        if (culprits.size > 0) {
          dropSourceOverlays(culprits);
          adopt(reload());
          if (!frontendLowerable(current, coverage)) return unlowerable(result.stats, coverage);
          continue;
        }
        // Coverage keeps its blockers rather than probing.
        const used = frontendOverlayKeys(current);
        if (coverage || result.diagnostics.length === 0 || used.length === 0) return result;
        const snapshot = snapshotSourceOverlayDrops();
        const reason = surfaceReason("compile", result.diagnostics);
        for (const key of used) dropSourceOverlay(key, reason);
        const probe = reload();
        if (frontendLowerable(probe, false)) {
          const lowered = probe.lower(opts);
          if (lowered.diagnostics.length === 0) {
            adopt(probe);
            return lowered;
          }
        }
        probe.dispose();
        restoreSourceOverlayDrops(snapshot);
        return result;
      }
    },
  };
  return fe;
}

export function runFrontend(
  entryPath: string,
  loadProgram: ProgramLoader,
  npmStatic?: readonly string[] | "auto" | "lib",
  externalTypes?: Readonly<Record<string, string>>,
  libraryNpmStatic: readonly string[] = [],
): Frontend {
  // A preflight or package probe may throw after its host has opened. Track
  // only live loads, releasing each immediately on normal fallback; this
  // also closes both the current program and a failed temporary probe.
  const active: ReturnType<ProgramLoader>[] = [];
  const trackedLoader: ProgramLoader = (path, options) => {
    const load = loadProgram(path, options);
    active.push(load);
    return {
      ...load,
      dispose: () => {
        const index = active.indexOf(load);
        if (index < 0) return;
        active.splice(index, 1);
        load.dispose();
      },
    };
  };
  try {
    // Every executable and library closes over its dependencies. Explicit
    // selections bypass eligibility heuristics, but never compilation checks.
    const explicit: readonly string[] =
      npmStatic !== undefined && typeof npmStatic !== "string" ? npmStatic : [];
    const load = (): Frontend =>
      loadFrontend(entryPath, trackedLoader, "lib", externalTypes, [
        ...new Set([...libraryNpmStatic, ...explicit]),
      ]);
    beginSourceOverlayCompile();
    const first = load();
    return sourceOverlaysActive()
      ? withSourceOverlayLoweringFallback(first, load, entryPath)
      : first;
  } catch (error) {
    for (const load of active) {
      // Preserve the original failure and attempt every remaining cleanup.
      try {
        load.dispose();
      } catch {
        /* best effort after a failed load */
      }
    }
    throw error;
  }
}

function loadFrontend(
  entryPath: string,
  loadProgram: ProgramLoader,
  npmStatic?: readonly string[] | "auto" | "lib",
  externalTypes?: Readonly<Record<string, string>>,
  libraryNpmStatic: readonly string[] = [],
): Frontend {
  // Resolver package/workspace metadata is intentionally shared across the
  // several load attempts of ONE auto-detection fixpoint, but never across
  // separate compiles in a long-lived process.  A cache miss must observe
  // package.json edits before it can publish a new early-library entry.
  clearResolveCaches();
  const statuses: NpmStaticStatus[] = [];
  const npmSites = new Map<string, SrcLoc>();
  // Explicit library attempts bypass only the auto-selection heuristics.
  // The shared preflight/lowering refusal and dependency-closure checks remain.
  const judged = new Set<string>(libraryNpmStatic);
  let requested: string[] = [];
  let reusableScout: ReturnType<typeof loadProgram> | null = null;
  let reusablePreflight: ScrDiagnostic[] | null = null;
  if (npmStatic === "auto" || npmStatic === "lib") {
    const scout = loadProgram(entryPath, { externalTypes });
    let retained = false;
    let overlayCulprits = new Map<string, string>();
    try {
      const scoutPreflight = checkPreflight(scout);
      // --sources: overlays that already fail here fall back before any
      // package selection depends on them.
      overlayCulprits = sourceOverlayCulprits(scout, scoutPreflight);
      if (overlayCulprits.size === 0) {
        requested =
          npmStatic === "lib"
            ? [...libraryNpmStatic, ...detectAutoPackages(scout, statuses, "lib", judged, npmSites)]
            : detectAutoPackages(scout, statuses);
        // With no package to opt in, the scout already IS the final frontend:
        // same roots, resolution posture, preflight, and module order. Retain it
        // instead of spawning a second tsgo server and checking the whole graph
        // again — the common library-mode path has no bare npm imports.
        if (requested.length === 0) {
          reusableScout = scout;
          reusablePreflight = scoutPreflight;
          retained = true;
        }
      }
    } finally {
      if (!retained) scout.dispose();
    }
    if (overlayCulprits.size > 0) {
      dropSourceOverlays(overlayCulprits);
      return loadFrontend(entryPath, loadProgram, npmStatic, externalTypes, libraryNpmStatic);
    }
  } else if (npmStatic !== undefined) {
    requested = [...new Set(npmStatic)];
  }

  // One exact --external-types mapping makes the containing package an
  // external host boundary, which cannot simultaneously be compiled as a
  // package-wide --npm-static program graph. External wins; retain the
  // npm-static refusal record so explicit and auto requests both
  // explain why the package did not compile statically.
  if (requested.length > 0 && externalTypes !== undefined) {
    const externalSpecifiersByPackage = new Map<string, string[]>();
    for (const specifier of Object.keys(externalTypes)) {
      const pkg = packageNameOfSpecifier(specifier);
      const specs = externalSpecifiersByPackage.get(pkg) ?? [];
      specs.push(specifier);
      externalSpecifiersByPackage.set(pkg, specs);
    }
    requested = requested.filter((pkg) => {
      const specs = externalSpecifiersByPackage.get(pkg);
      if (specs === undefined) return true;
      statuses.push({
        package: pkg,
        status: "refused",
        detail: `mapped as an external host module by --external-types (${specs.map((s) => JSON.stringify(s)).join(", ")})`,
      });
      return false;
    });
  }

  // Package-anchored preflight failures and attributable consumer errors
  // remove that package from the active source graph. Reloading restores
  // its declarations for analysis; the recorded refusal stops executable
  // and library builds with a package-specific diagnostic.
  let load = reusableScout ?? loadProgram(entryPath, { npmStatic: requested, externalTypes });
  let preflight = reusablePreflight ?? checkPreflight(load);
  // Library mode's fixpoint: the opted-in packages' files joined the
  // program just now, and THEIR bare edges (import statements and
  // top-level requires) name packages the scout could not see. Judge each
  // by the same bar — eligible ones join the set and the frontend
  // reloads; ineligible ones record a refusal. Bounded by the dependency
  // count (every iteration settles
  // at least one new package for good).
  if (npmStatic === "lib") {
    for (;;) {
      const grown = detectAutoPackages(load, statuses, "lib", judged, npmSites);
      if (grown.length === 0) break;
      requested = [...requested, ...grown];
      load.dispose();
      load = loadProgram(entryPath, { npmStatic: requested, externalTypes });
      preflight = checkPreflight(load);
    }
  }
  const effective = new Set(requested);
  // Packages refused only because the program does not typecheck against
  // their inferred surface (no offender, no package-anchored diagnostic).
  const typecheckRefused = new Set<string>();
  while (effective.size > 0) {
    const reasons = new Map<string, string>(npmStaticOffenders());
    for (const d of preflight) {
      const pkg = npmStaticPackageOfPath(d.loc.file);
      if (pkg !== null && !reasons.has(pkg)) reasons.set(pkg, `${d.code}: ${d.message}`);
    }
    if (![...reasons.keys()].some((p) => effective.has(p))) {
      const named = new Map<string, number>();
      for (const d of preflight) {
        if (d.code !== "SC0001") continue;
        for (const pkg of packagesNamedByDiag(d.message, effective)) {
          named.set(pkg, (named.get(pkg) ?? 0) + 1);
        }
      }
      for (const [pkg, count] of named) {
        typecheckRefused.add(pkg);
        reasons.set(
          pkg,
          `its inferred export surface breaks ${count} import site${count === 1 ? "" : "s"} in program files (bundler-emitted surfaces type only as far as inference reaches)`,
        );
      }
    }
    const dropping = [...reasons.keys()].filter((p) => effective.has(p));
    if (dropping.length === 0) break;
    for (const p of dropping) {
      effective.delete(p);
      statuses.push({ package: p, status: "refused", detail: reasons.get(p)! });
    }
    load.dispose();
    load = loadProgram(entryPath, { npmStatic: [...effective], externalTypes });
    preflight = checkPreflight(load);
  }
  // The last resort, ALL modes: an opt-in can change the PROGRAM's OWN
  // typecheck through errors that name no package at all (declaration
  // shapes outside the safe overload projection — generic overloads,
  // declaration-only members, or a .d.ts type-GUARD an inferred JS
  // function cannot reproduce). Those SC0001s anchor in USER files no
  // offender or
  // message attribution reaches, so each remaining package is probed
  // ALONE-dropped (n is the opt-in count — a handful of extra analysis
  // loads); culprits whose removal clears the errors fall back with a
  // note, and if no subset typechecks, everything drops. Explicit opt-ins
  // degrade the same way — the ratified stance for bundle-shaped dists is
  // graceful per-package degradation, never a failed gate the user cannot
  // act on (the note carries the why).
  if (effective.size > 0 && preflight.some((d) => d.code === "SC0001")) {
    const dropWithNote = (p: string): void => {
      effective.delete(p);
      typecheckRefused.add(p);
      statuses.push({
        package: p,
        status: "refused",
        detail:
          npmStatic === "auto"
            ? "auto: the program does not typecheck against its inferred surface"
            : npmStatic === "lib"
              ? "the program does not typecheck against its inferred surface (type-only declarations and .d.ts type guards have no JS value inference can chase)"
              : "the program does not typecheck against its inferred surface (type-only declarations and .d.ts type guards have no JS value inference can chase)",
      });
    };
    // Attribute per package by probing each SOLO (culprits are almost
    // always independent — each package's inferred surface breaks its own
    // import sites), then reload with the survivors; interaction effects
    // that still fail drop everything left.
    for (const p of [...effective]) {
      const probe = loadProgram(entryPath, { npmStatic: [p], externalTypes });
      const probeDiags = checkPreflight(probe);
      probe.dispose();
      if (probeDiags.some((d) => d.code === "SC0001")) dropWithNote(p);
    }
    load.dispose();
    load = loadProgram(entryPath, { npmStatic: [...effective], externalTypes });
    preflight = checkPreflight(load);
    if (preflight.some((d) => d.code === "SC0001") && effective.size > 0) {
      for (const p of [...effective]) dropWithNote(p);
      load.dispose();
      load = loadProgram(entryPath, { npmStatic: [...effective], externalTypes });
      preflight = checkPreflight(load);
    }
  }
  for (const p of requested) {
    if (effective.has(p)) statuses.push({ package: p, status: "static" });
  }
  // The final program types the refused packages by their own
  // declarations. If it still fails to typecheck, the type errors are the
  // program's, not the packages': report them at their own locations
  // instead of a package refusal that hides them.
  if (typecheckRefused.size > 0 && preflight.some((d) => d.code === "SC0001")) {
    for (let i = statuses.length - 1; i >= 0; i--) {
      const s = statuses[i]!;
      if (s.status === "refused" && typecheckRefused.has(s.package)) statuses.splice(i, 1);
    }
  }

  // --sources: npm packages joining the program can expose new overlay
  // failures (a published CommonJS dependency's require() of an augmented
  // package, a preflight error only the full graph reaches). Drop those
  // instances and restart the whole selection without them.
  const lateCulprits = sourceOverlayCulprits(load, preflight);
  if (lateCulprits.size > 0) {
    dropSourceOverlays(lateCulprits);
    load.dispose();
    return loadFrontend(entryPath, loadProgram, npmStatic, externalTypes, libraryNpmStatic);
  }
  const overlaysUsed = usedSourceOverlays(load);
  // The preflight last resort: errors no overlay is blamed for may still
  // come from typing the program against the overlays' source surface.
  // Probe with every used overlay dropped and keep the probe only when it
  // preflights cleanly.
  if (overlaysUsed.size > 0 && preflight.length > 0) {
    const snapshot = snapshotSourceOverlayDrops();
    const reason = surfaceReason("typecheck", preflight);
    for (const key of overlaysUsed) dropSourceOverlay(key, reason);
    const probe = loadFrontend(entryPath, loadProgram, npmStatic, externalTypes, libraryNpmStatic);
    if (
      probe.preflight.length === 0 &&
      !probe.npmStatic.some((entry) => entry.status === "refused")
    ) {
      load.dispose();
      return probe;
    }
    probe.dispose();
    restoreSourceOverlayDrops(snapshot);
  }
  for (const instance of sourceOverlaySet()?.instances ?? []) {
    const dropped = sourceOverlayDropReason(instance.key);
    if (dropped !== null) {
      statuses.push({
        package: `${instance.name}@${instance.version}`,
        status: "source-fallback",
        detail: `source overlay: ${dropped}`,
      });
    } else if (overlaysUsed.has(instance.key)) {
      statuses.push({ package: `${instance.name}@${instance.version}`, status: "source" });
    }
  }

  const finalLoad = load;
  return {
    preflight,
    entryText: () => finalLoad.entry.text,
    entryExports: () => entryFunctionExports(finalLoad.entry),
    // The contract scans the PROGRAM's source files, not the runtime
    // module order: a type-only module (nothing but exported types) has no
    // runtime edge and never joins moduleOrder, yet its declarations are
    // contract surface. Declaration files (default libs, @types) stay out,
    // and so do statically-compiled npm packages' files: their .d.ts is
    // dropped by construction (inference types the bodies), so no npm
    // declaration can name a wire-contract type — the contract vocabulary
    // is authored program surface only, and a workspace-linked package's
    // shipped .ts must not smuggle same-name declarations into the type
    // table.
    entryContract: () =>
      entryContractFacts(
        finalLoad.entry,
        finalLoad.program
          .getImplementationSourceFiles()
          .filter((sf) => !sf.isDeclarationFile && npmStaticPackageOfPath(sf.fileName) === null),
      ),
    // Runtime evaluation order first, then any type-only program modules
    // (no runtime edge, so absent from moduleOrder — but they are contract
    // surface now, and the library identity hashes cover the WHOLE module
    // graph; the Map dedups by fileName). Statically-compiled npm modules
    // are in moduleOrder like any program module, so their bytes join the
    // library identity hashes (source_hash/build_id) — compiled code is
    // identity, whatever directory it came from.
    sourceTexts: () =>
      new Map<string, string>(
        [
          finalLoad.entry,
          ...finalLoad.moduleOrder,
          ...finalLoad.program.getImplementationSourceFiles().filter((sf) => !sf.isDeclarationFile),
        ].map((sf) => [sf.fileName, sf.text]),
      ),
    lower: (opts) =>
      lowerToIr(finalLoad.program, finalLoad.entry, finalLoad.moduleOrder, {
        ...opts,
        frontendServices: finalLoad.services,
        startupCrash: finalLoad.startupCrash ?? null,
        projectCheckJs: finalLoad.typeWorld?.projectCheckJs ?? false,
        externalTypes: finalLoad.externalTypes,
        externalTypeSpecifiersByFile: finalLoad.externalTypeSpecifiersByFile,
      }),
    npmStatic: statuses,
    npmImportSites: npmSites,
    sourceOverlays: () => sourceOverlayReport(overlaysUsed),
    dispose: finalLoad.dispose,
  };
}

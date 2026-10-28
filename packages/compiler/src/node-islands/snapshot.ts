/* Deferred island modules: the decision, the build-time probe and the
 * interface snapshot (scope-B NI-7, DESIGN.md §2.7, §5.4).
 *
 * Lowering emits `nodeIsland.defer(path, "")` for every static import of an
 * island module (lower-node-island.ts). After lowering, once the build
 * knows the libnode pack the executable will load, finalizeDeferredIslands
 * decides each one:
 *
 *   - the package's `evaluate` setting (`scriptc.packages.<name>`):
 *     "eager" keeps the module eager; "lazy" skips the static effect gate
 *     and the probe's effect log (the user judged the effects benign);
 *     "auto" (the default) needs both;
 *   - the static effect gate (effect-gate.ts) over the module's closure;
 *   - the probe: one run of the build-time probe host
 *     (runtime src/tools/scr_node_island_probe.c) in a libnode environment
 *     from the same pack, which loads every candidate module, records what
 *     it can observe of their evaluation (output, warnings, listeners,
 *     timers, new globals, a throw) and takes the interface snapshot of
 *     each module's value;
 *
 * and rewrites the call: a deferred module keeps `nodeIsland.defer` with
 * its snapshot text (format: runtime scr_node_island_boot.c), any other
 * becomes the eager `nodeIsland.require(path)`. Without a pack on the
 * build host there is no probe, and every island stays eager. */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveBuildCacheRoot } from "../backend/cache-root.js";
import type { IrExpr, IrModule } from "../ir/ir.js";
import { readProjectConfig } from "../project-config.js";
import { effectGate } from "./effect-gate.js";
import { packageDirOf } from "./origin.js";

type DeferCall = Extract<IrExpr, { kind: "libCall" }>;

function deferCalls(mod: IrModule): DeferCall[] {
  const found: DeferCall[] = [];
  const seen = new Set<object>();
  const walk = (v: unknown): void => {
    if (v === null || typeof v !== "object" || seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) {
      for (const x of v) walk(x);
      return;
    }
    const o = v as Record<string, unknown>;
    if (o["kind"] === "libCall" && o["fn"] === "nodeIsland.defer") found.push(o as DeferCall);
    for (const k in o) if (k !== "loc" && k !== "type") walk(o[k]);
  };
  walk(mod.functions);
  walk(mod.globals);
  return found;
}

function pathOf(call: DeferCall): string {
  const arg = call.args[0];
  return arg !== undefined && arg.kind === "strLit" ? arg.value : "";
}

/** The build machine's file of a load's path: a `./` path names a file of
 * the shipped module tree (node-islands/modules.ts), under its root. */
function fileOf(mod: IrModule, path: string): string {
  const tree = mod.nodeIsland?.modules;
  return tree !== undefined && path.startsWith("./") ? join(tree.root, path.slice(2)) : path;
}

function makeEager(call: DeferCall): void {
  (call as { fn: string }).fn = "nodeIsland.require";
  call.args.length = 1;
}

export interface DeferralDecision {
  path: string;
  deferred: boolean;
  reason: string;
}

/** SCRIPTC_NODE_ISLANDS_TRACE=defer at build time prints each decision. */
function traceDecision(d: DeferralDecision): void {
  const t = process.env["SCRIPTC_NODE_ISLANDS_TRACE"];
  if (t !== undefined && t.includes("defer"))
    process.stderr.write(
      `[node-islands] ${d.deferred ? "defer" : "eager"} ${d.path}${d.reason ? `: ${d.reason}` : ""}\n`,
    );
}

export function finalizeDeferredIslands(
  mod: IrModule,
  entryPath: string,
  packDir: string | null,
): DeferralDecision[] {
  const calls = deferCalls(mod);
  if (calls.length === 0) return [];
  const decisions: DeferralDecision[] = [];
  const decide = (call: DeferCall, deferred: boolean, reason: string): void => {
    const d = { path: fileOf(mod, pathOf(call)), deferred, reason };
    decisions.push(d);
    traceDecision(d);
    if (!deferred) makeEager(call);
  };
  if (packDir === null) {
    for (const c of calls) decide(c, false, "no libnode pack on the build host to probe with");
    return decisions;
  }
  const config = readProjectConfig(entryPath);
  const candidates: { call: DeferCall; path: string; lazy: boolean; files: string[] }[] = [];
  for (const call of calls) {
    const path = fileOf(mod, pathOf(call));
    const pkg = packageDirOf(path);
    const evaluate = pkg === null ? "auto" : (config.packages.get(pkg.name)?.evaluate ?? "auto");
    if (evaluate === "eager") {
      decide(call, false, `"evaluate": "eager"`);
      continue;
    }
    const gate = effectGate(path);
    if (!gate.ok && evaluate !== "lazy") {
      decide(call, false, `${gate.reason} in ${gate.file}`);
      continue;
    }
    candidates.push({
      call,
      path,
      lazy: evaluate === "lazy",
      files: gate.ok ? gate.files : [path],
    });
  }
  if (candidates.length === 0) return decisions;
  const probe = runProbe(packDir, [...new Set(candidates.map((c) => c.path))]);
  if (typeof probe === "string") {
    for (const c of candidates) decide(c.call, false, probe);
    return decisions;
  }
  const packGuards = packGuardLines(packDir);
  // The shipped tree's files are the executable's own (the tree is checked
  // against its digests when it opens): only files outside it need guards.
  const tree = mod.nodeIsland?.modules;
  const shipped = new Set(tree?.files.map((f) => join(tree.root, f.path)) ?? []);
  for (const c of candidates) {
    const result = probe.results.find((r) => r.path === c.path);
    if (result?.throws !== undefined) {
      decide(c.call, false, `its evaluation throws: ${result.throws}`);
      continue;
    }
    if (result === undefined || result.root === undefined) {
      decide(c.call, false, result?.reason ?? "the probe did not load it");
      continue;
    }
    if (result.effects.length > 0 && !c.lazy) {
      decide(c.call, false, `the probe saw ${result.effects.join(", ")}`);
      continue;
    }
    if (
      tree !== undefined &&
      tree.root.length > 1 &&
      snapshotNames(probe, result.root, tree.root)
    ) {
      decide(c.call, false, "its exports hold a path of the build machine");
      continue;
    }
    const files = c.files.filter((f) => !shipped.has(f));
    const text = encodeSnapshot(probe, result.root, [...packGuards, ...fileGuardLines(files)]);
    const arg = c.call.args[1];
    if (arg !== undefined && arg.kind === "strLit") (arg as { value: string }).value = text;
    decide(c.call, true, "");
  }
  return decisions;
}

/* ── the snapshot text (scr_node_island_boot.c) ───────────────────────── */

function lstr(s: string): string {
  return `${Buffer.byteLength(s, "utf8")}:${s}`;
}

function guardLine(name: string, file: string): string | null {
  try {
    const st = statSync(file, { bigint: true });
    return `G ${lstr(name)} ${st.size} ${st.mtimeNs}`;
  } catch {
    return null;
  }
}

function packGuardLines(packDir: string): string[] {
  const lines: string[] = [];
  let manifest: { libnode?: string; bridge?: string; files?: Record<string, unknown> } = {};
  try {
    manifest = JSON.parse(readFileSync(join(packDir, "manifest.json"), "utf8"));
  } catch {
    /* the pack was validated by the build already */
  }
  const names = new Set<string>(Object.keys(manifest.files ?? {}));
  if (manifest.libnode) names.add(manifest.libnode);
  if (manifest.bridge) names.add(manifest.bridge);
  for (const name of [...names].sort()) {
    const line = guardLine(`@${name}`, join(packDir, name));
    if (line !== null) lines.push(line);
  }
  return lines;
}

function fileGuardLines(files: string[]): string[] {
  const lines: string[] = [];
  for (const f of files) {
    const line = guardLine(f, f);
    if (line !== null) lines.push(line);
  }
  return lines;
}

type ProbeValue =
  | { o: number }
  | { u: 1 }
  | { l: 1 }
  | { b: boolean }
  | { n: string }
  | { s: string }
  | { x: 1 };

interface ProbeObject {
  f: number;
  p: boolean;
  m: [string, ProbeValue][];
}

interface ProbeOutput {
  results: { path: string; root?: number; effects: string[]; throws?: string; reason?: string }[];
  objects: Record<string, ProbeObject>;
}

function encodeValue(v: ProbeValue): string | null {
  if ("o" in v) return `o${v.o}`;
  if ("u" in v) return "u";
  if ("l" in v) return "l";
  if ("b" in v) return v.b ? "t" : "f";
  if ("n" in v) return `n${v.n}`;
  if ("s" in v) return `s${lstr(v.s)}`;
  return null;
}

/** Whether a string the snapshot holds names a path under `dir`. The
 * probe loads the modules from the build machine, and the program from the
 * module tree it ships, so such a value would not be the one the program
 * sees (a module's own `__dirname`, say). */
function snapshotNames(probe: ProbeOutput, root: number, dir: string): boolean {
  const seen = new Set<number>();
  const visit = (oid: number): boolean => {
    if (seen.has(oid) || probe.objects[oid] === undefined) return false;
    seen.add(oid);
    for (const [, v] of probe.objects[oid]!.m) {
      if ("s" in v && v.s.includes(dir)) return true;
      if ("o" in v && visit(v.o)) return true;
    }
    return false;
  };
  return visit(root);
}

function encodeSnapshot(probe: ProbeOutput, root: number, guards: string[]): string {
  const lines = [...guards];
  const reached: number[] = [];
  const seen = new Set<number>();
  const visit = (oid: number): void => {
    if (seen.has(oid) || probe.objects[oid] === undefined) return;
    seen.add(oid);
    reached.push(oid);
    for (const [, v] of probe.objects[oid]!.m) if ("o" in v) visit(v.o);
  };
  visit(root);
  for (const oid of reached) {
    const o = probe.objects[oid]!;
    lines.push(`O ${oid} ${o.f} ${o.p ? 1 : 0}`);
  }
  for (const oid of reached) {
    for (const [key, v] of probe.objects[oid]!.m) {
      const enc = encodeValue(v);
      if (enc !== null) lines.push(`K ${oid} ${lstr(key)} ${enc}`);
    }
  }
  lines.push(`R ${root}`);
  return lines.join("\n");
}

/* ── the probe ────────────────────────────────────────────────────────── */

/** The bootstrap the probe host starts Node with: the dispatcher the
 * bridge requires, and the probe as its `call`. */
const PROBE_BOOTSTRAP = String.raw`
"use strict";
const types = require("node:util").types;
const { createRequire } = require("node:module");
const noop = () => {};
globalThis.__scriptcNodeIsland = {
  call(id, sync, file, specifier, name, args) {
    try {
      return "R" + JSON.stringify(probe(JSON.parse(args)));
    } catch (e) {
      return "T" + JSON.stringify(String((e && e.stack) || e));
    }
  },
  setTimer: noop, clearTimer: noop, refTimer: noop, refreshTimer: noop,
  setImmediate: noop, clearImmediate: noop, refImmediate: noop,
  nextTick: noop, emit: noop, load: noop, sharedPush: noop,
};
const fnToString = Function.prototype.toString;
const hasOwn = Object.prototype.hasOwnProperty;
function isConstructor(f) {
  try { Reflect.construct(String, [], f); return true; } catch { return false; }
}
function plainClass(f) {
  // instanceof reads the prototype: without an object there, it throws.
  const proto = Object.getOwnPropertyDescriptor(f, "prototype");
  if (proto === undefined || !("value" in proto)) return false;
  if (proto.value === null || (typeof proto.value !== "object" && typeof proto.value !== "function"))
    return false;
  let source = "";
  try { source = fnToString.call(f); } catch { return false; }
  if (/\[native code\]\s*\}$/.test(source)) return false;
  for (let o = f; o !== null && o !== Function.prototype; o = Object.getPrototypeOf(o))
    if (hasOwn.call(o, Symbol.hasInstance)) return false;
  return true;
}
function probe(input) {
  const objects = {};
  const oids = new Map();
  let next = 1;
  const value = (v, depth) => {
    if (v === undefined) return { u: 1 };
    if (v === null) return { l: 1 };
    switch (typeof v) {
      case "boolean": return { b: v };
      case "number": return { n: Object.is(v, -0) ? "-0" : String(v) };
      case "string": return v.isWellFormed() ? { s: v } : { x: 1 };
      case "symbol": return object(v, 2, depth);
      case "function":
        if (types.isProxy(v)) return { x: 1 };
        return object(v, 1 | (isConstructor(v) ? 32 : 0), depth);
      case "object":
        if (types.isProxy(v) || types.isPromise(v) || types.isNativeError(v) ||
            ArrayBuffer.isView(v) || types.isExternal(v)) return { x: 1 };
        return object(v, Array.isArray(v) ? 8 : 0, depth);
      default: return { x: 1 };
    }
  };
  const object = (v, flags, depth) => {
    if (oids.has(v)) return { o: oids.get(v) };
    const id = next++;
    oids.set(v, id);
    const entry = { f: flags, p: (flags & 1) !== 0 && plainClass(v), m: [] };
    objects[id] = entry;
    if (typeof v === "symbol") return { o: id };
    // The module's value and its direct members: every own data property
    // (namespace member lists); functions anywhere: name and length.
    const keys = depth === 0 || (depth === 1 && typeof v !== "function")
      ? Object.getOwnPropertyNames(v)
      : typeof v === "function" ? ["name", "length"] : [];
    for (const key of keys) {
      let d;
      try { d = Object.getOwnPropertyDescriptor(v, key); } catch { continue; }
      if (d === undefined || !("value" in d)) continue;
      entry.m.push([key, value(d.value, depth + 1)]);
    }
    return { o: id };
  };
  const effects = [];
  const watch = (owner, key, label) => {
    const original = owner[key];
    if (typeof original !== "function") return () => {};
    owner[key] = function (...a) { effects.push(label); return original.apply(this, a); };
    return () => { owner[key] = original; };
  };
  const results = [];
  for (const path of input.modules) {
    effects.length = 0;
    const globals = new Set(Reflect.ownKeys(globalThis));
    const restore = [
      watch(process.stdout, "write", "stdout output"),
      watch(process.stderr, "write", "stderr output"),
      watch(process, "emitWarning", "a process warning"),
      watch(process, "on", "a process listener"),
      watch(process, "addListener", "a process listener"),
      watch(process, "once", "a process listener"),
      watch(process, "prependListener", "a process listener"),
      watch(process, "nextTick", "process.nextTick"),
      watch(globalThis, "setTimeout", "a timer"),
      watch(globalThis, "setInterval", "a timer"),
      watch(globalThis, "setImmediate", "an immediate"),
      watch(globalThis, "queueMicrotask", "a microtask"),
    ];
    let exportsValue, threw;
    try { exportsValue = createRequire(path)(path); } catch (e) { threw = String((e && e.message) || e); }
    for (const r of restore) r();
    for (const k of Reflect.ownKeys(globalThis))
      if (!globals.has(k)) effects.push("a new global " + String(k));
    if (threw !== undefined) { results.push({ path, effects: [...effects], throws: threw }); continue; }
    const root = value(exportsValue, 0);
    if (!("o" in root)) {
      results.push({ path, effects: [...effects], reason: "its value is not an object" });
      continue;
    }
    results.push({ path, root: root.o, effects: [...new Set(effects)] });
  }
  return { results, objects };
}
`;

function runtimeSrc(): string {
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve("@scriptc/runtime/package.json")), "src");
}

/** Whether only the current user can write `path` (and it is theirs). */
function writableByUserOnly(path: string): boolean {
  const info = statSync(path);
  const uid = process.getuid?.();
  return (uid === undefined || info.uid === uid) && (info.mode & 0o022) === 0;
}

/** Where the probe host is built. The build runs it with the compiler's
 * privileges, so it never comes from a directory another user can write:
 * it is kept in the user's build cache when that and the directories below
 * it are the user's own, else built in a fresh private temporary directory
 * the probe removes when it ends. */
export function probeHostDirectory(hash: string): { dir: string; kept: boolean } {
  const root = resolveBuildCacheRoot();
  if (root !== null) {
    const dir = join(root, "node-island-probe", hash);
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      if ([root, dirname(dir), dir].every(writableByUserOnly)) return { dir, kept: true };
    } catch {
      /* not usable: a temporary directory instead */
    }
  }
  return { dir: mkdtempSync(join(tmpdir(), "scriptc-node-probe-")), kept: false };
}

/** The probe host executable, built once per probe source and bridge
 * header (in the directory probeHostDirectory picks). */
function probeHost(): { exe: string; bootstrap: string; kept: boolean } | string {
  const src = runtimeSrc();
  const source = join(src, "tools", "scr_node_island_probe.c");
  const header = join(src, "scr_node_bridge.h");
  const hash = createHash("sha256")
    .update(readFileSync(source))
    .update(readFileSync(header))
    .update(PROBE_BOOTSTRAP)
    .digest("hex")
    .slice(0, 16);
  const { dir, kept } = probeHostDirectory(hash);
  const exe = join(dir, "scr-node-probe");
  const bootstrap = join(dir, "bootstrap.js");
  if (
    kept &&
    existsSync(exe) &&
    existsSync(bootstrap) &&
    [exe, bootstrap].every(writableByUserOnly)
  )
    return { exe, bootstrap, kept };
  const tmp = `${exe}.${process.pid}`;
  const errors: string[] = [];
  for (const cc of [process.env["CC"], "clang", "cc"]) {
    if (cc === undefined || cc === "") continue;
    const r = spawnSync(cc, ["-O1", "-I", src, source, "-o", tmp, "-ldl"], { encoding: "utf8" });
    if (r.status === 0) {
      writeFileSync(`${bootstrap}.${process.pid}`, PROBE_BOOTSTRAP, { mode: 0o600 });
      renameSync(`${bootstrap}.${process.pid}`, bootstrap);
      renameSync(tmp, exe);
      return { exe, bootstrap, kept };
    }
    errors.push(`${cc}: ${r.error?.message ?? r.stderr.trim().split("\n")[0]}`);
  }
  if (!kept) rmSync(dir, { recursive: true, force: true });
  return `cannot build the probe host (${errors.join("; ")})`;
}

function runProbe(packDir: string, modules: string[]): ProbeOutput | string {
  const host = probeHost();
  if (typeof host === "string") return host;
  const { exe, bootstrap, kept } = host;
  const input = join(dirname(exe), `input.${process.pid}.${Date.now()}.json`);
  writeFileSync(input, JSON.stringify({ modules }), { mode: 0o600 });
  let out: string;
  try {
    out = execFileSync(exe, [packDir, bootstrap, input], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
      timeout: 60_000,
    });
  } catch (e) {
    const err = e as { stderr?: string; message: string };
    return `the probe failed: ${(err.stderr ?? "").trim().split("\n")[0] || err.message}`;
  } finally {
    try {
      rmSync(kept ? input : dirname(exe), { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
  if (!out.startsWith("R")) return `the probe threw: ${out.slice(1, 400)}`;
  return JSON.parse(out.slice(1)) as ProbeOutput;
}

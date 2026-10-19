/* Native units: runtime modules written in the native subset of TypeScript
 * (`"use native";`, @scriptc/experimental/native), compiled to LLVM IR with
 * no runtime underneath. See docs in lower.ts (the subset), probe.ts (how
 * the IR follows the C runtime's flags) and emit.ts (the IR's shape). */
import { basename, resolve } from "node:path";
import type { ScrDiagnostic } from "../diagnostics/diagnostic.js";
import { loadProgram } from "../frontend/program-node.js";
import {
  emitNativeModule,
  mergeNativeModule,
  nameCounter,
  nativeLayoutAsserts,
  nativeShapes,
} from "./emit.js";
import { lowerNativeModule, type NativeTarget } from "./lower.js";
import { parseProbe, type NativeProbe } from "./probe.js";

export { nativeProbeSource } from "./probe.js";
export { isNativeModuleSource } from "./lower.js";

export interface NativeUnitOptions {
  /** The probe compiled with the unit's flags (probe.ts). */
  probe: string;
  /** A C unit's frontend IR, compiled with the module's stand-in bodies,
   * to put the module's functions into in their place (emit.ts:
   * mergeNativeModule), instead of emitting a module of its own. */
  into?: string;
  /** Also make the stand-in bodies for the C header (emit.ts: nativeShapes). */
  shapes?: boolean;
  /** With `into`: also restore clang's name counter (emit.ts: nameCounter),
   * for the first module merged into a unit. */
  nameCounter?: boolean;
}

export interface NativeUnitResult {
  llvm: string | null;
  /** C `_Static_assert`s on the layouts of the struct interfaces the
   * module uses (emit.ts: nativeLayoutAsserts). */
  layoutAsserts: string | null;
  /** The stand-in bodies for the C header, when asked for. */
  shapes: string | null;
  /** The module that restores clang's name counter, to link into `llvm`
   * with `-mlink-builtin-bitcode`, when asked for and the counter needs
   * one. */
  nameCounter: string | null;
  diagnostics: ScrDiagnostic[];
}

/** The `target` a native module sees, from the probe: the triple's OS
 * and architecture, the pointer width, and the build's flags. */
function targetOf(probe: NativeProbe): NativeTarget {
  const [arch = "", , os = ""] = probe.triple.split("-");
  return {
    pointerBytes: probe.pointerBytes,
    arch: arch === "x86_64" ? "x64" : arch === "aarch64" || arch === "arm64" ? "arm64" : arch,
    os: /^(darwin|macos|ios)/.test(os)
      ? "darwin"
      : os.startsWith("windows")
        ? "windows"
        : os.startsWith("wasi")
          ? "wasi"
          : os.startsWith("linux")
            ? "linux"
            : os,
    flags: probe.config,
  };
}

export function compileNativeUnit(entryPath: string, options: NativeUnitOptions): NativeUnitResult {
  const entry = resolve(entryPath);
  const probe = parseProbe(options.probe);
  const load = loadProgram(entry);
  try {
    const { module, diagnostics } = lowerNativeModule(load.program, load.entry, targetOf(probe));
    const all = [...load.configDiags, ...diagnostics];
    if (module === null || all.length > 0)
      return { llvm: null, layoutAsserts: null, shapes: null, nameCounter: null, diagnostics: all };
    const counter =
      options.into !== undefined && options.nameCounter === true
        ? nameCounter(options.into, probe)
        : null;
    let llvm =
      options.into === undefined
        ? emitNativeModule(module, probe, basename(entry))
        : mergeNativeModule(module, probe, options.into);
    if (counter !== null) llvm += counter.declarations.join("\n") + "\n";
    return {
      llvm,
      nameCounter: counter?.counter ?? null,
      layoutAsserts: nativeLayoutAsserts(module),
      shapes: options.shapes === true ? nativeShapes(module, probe) : null,
      diagnostics: [],
    };
  } finally {
    load.dispose();
  }
}

// Native units: runtime code written in the native subset of TypeScript
// (packages/compiler/src/native-unit). A native unit replaces the inline
// definitions of a header; every C unit that includes the header gets the
// native unit's functions as it would get the header's `static inline`
// definitions:
//
//   1. the probe (`native-unit/cli.js --print-probe`), compiled with the C
//      unit's flags up to clang's frontend, gives the attributes, ABI and
//      configuration the native IR must carry;
//   2. for those flags, each native unit gives the header the stand-in
//      bodies it defines the functions with under `-D<define>` (`--shapes`),
//      and its layout asserts are checked against the C headers;
//   3. the C unit is compiled up to clang's frontend with the stand-ins,
//      keeping its use-list order (`-emit-llvm-uselists`): clang places the
//      stand-ins, and orders the module and every use, as it does for the C
//      definitions;
//   4. each native unit's functions take the place of their stand-ins
//      (`--into`), and the result is compiled with the unit's flags, linking
//      in the module that gives LLVM's counter for unique global names the
//      value clang's frontend left it at (`--name-counter`).
//
// A unit whose frontend IR has no stand-ins is compiled from its source as
// before. Off unless SCRIPTC_NATIVE_UNITS is 1 (every native unit) or a
// comma-separated list of native unit sources, so packs build as before by
// default.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

export const NATIVE_UNITS = [
  { source: "scr_key.ts", define: "SCR_KEY_NATIVE" },
  { source: "scr_sa.ts", define: "SCR_SA_NATIVE" },
];

export function enabledNativeUnits(env = process.env) {
  const value = env.SCRIPTC_NATIVE_UNITS;
  if (value === undefined || value === "" || value === "0") return [];
  if (value === "1") return NATIVE_UNITS;
  const names = new Set(value.split(","));
  for (const name of names)
    if (!NATIVE_UNITS.some((unit) => unit.source === name))
      throw new Error(`SCRIPTC_NATIVE_UNITS names an unknown native unit: ${name}`);
  return NATIVE_UNITS.filter((unit) => names.has(unit.source));
}

/** Compiles runtime units, with the enabled native units in place of the
 * header definitions they replace. `run(command, args)` runs a process. */
export function createRuntimeUnitCompiler({
  run,
  compiler,
  compilerArgs,
  sourcePathFlags,
  repoRoot,
  runtimeSrc,
  workDir,
  units = enabledNativeUnits(),
}) {
  const cli = join(repoRoot, "packages/compiler/dist/native-unit/cli.js");
  const frontendOnly = ["-S", "-emit-llvm", "-Xclang", "-disable-llvm-passes"];
  const builds = new Map();
  let probeSource;

  const keyOf = (value) =>
    createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);

  /** A native unit's probe and stand-in header for `flags`, with the names
   * of its functions; built once per flag set. */
  const prepare = (unit, flags) => {
    const key = keyOf([unit.source, flags]);
    let build = builds.get(key);
    if (build === undefined) {
      build = (async () => {
        if (!existsSync(cli))
          throw new Error(
            `SCRIPTC_NATIVE_UNITS needs the built compiler (${cli}); run pnpm build first`,
          );
        await mkdir(workDir, { recursive: true });
        const stem = join(workDir, `${unit.source.replace(/\.ts$/, "")}-${key}`);
        probeSource ??= (await run(process.execPath, [cli, "--print-probe"])).stdout;
        await writeFile(`${stem}.probe.c`, probeSource);
        await run(compiler, [
          ...compilerArgs,
          ...flags,
          ...frontendOnly,
          `${stem}.probe.c`,
          "-o",
          `${stem}.probe.ll`,
        ]);
        await run(process.execPath, [
          cli,
          join(runtimeSrc, unit.source),
          "--probe",
          `${stem}.probe.ll`,
          "-o",
          `${stem}.ll`,
          "--layout-asserts",
          `${stem}.layout.h`,
          "--shapes",
          `${stem}.shapes.h`,
        ]);
        // The struct layouts must match the C headers'.
        await writeFile(
          `${stem}.layout.c`,
          `#include "scr_runtime.h"\n#include "${stem}.layout.h"\n`,
        );
        await run(compiler, [
          ...compilerArgs,
          ...flags,
          "-c",
          `${stem}.layout.c`,
          "-o",
          `${stem}.layout.o`,
        ]);
        const shapes = await readFile(`${stem}.shapes.h`, "utf8");
        return {
          unit,
          probe: `${stem}.probe.ll`,
          shapes: `${stem}.shapes.h`,
          functions: [...shapes.matchAll(/^#define SCR_NATIVE_SHAPE_(\w+) /gm)].map((m) => m[1]),
        };
      })();
      builds.set(key, build);
    }
    return build;
  };

  /** Compiles `source` to `output` with `flags`; `-emit-llvm` with `bitcode`. */
  return async function compileRuntimeUnit(source, output, flags, { bitcode = false } = {}) {
    const fromSource = () =>
      run(compiler, [
        ...compilerArgs,
        ...sourcePathFlags,
        ...flags,
        ...(bitcode ? ["-emit-llvm"] : []),
        "-c",
        source,
        "-o",
        output,
      ]);
    if (units.length === 0 || !source.endsWith(".c")) return fromSource();
    const prepared = await Promise.all(units.map((unit) => prepare(unit, flags)));
    const unitDir = join(workDir, "units", `${basename(source, ".c")}-${keyOf([output, bitcode])}`);
    await mkdir(unitDir, { recursive: true });
    const stem = join(unitDir, "unit");
    await run(compiler, [
      ...compilerArgs,
      ...sourcePathFlags,
      ...flags,
      ...prepared.map((p) => `-D${p.unit.define}="${p.shapes}"`),
      ...frontendOnly,
      "-Xclang",
      "-emit-llvm-uselists",
      source,
      "-o",
      `${stem}.fe.ll`,
    ]);
    const frontend = await readFile(`${stem}.fe.ll`, "utf8");
    const used = prepared.filter((p) =>
      p.functions.some((name) =>
        new RegExp(`^define internal [^@]*@${name}\\(`, "m").test(frontend),
      ),
    );
    if (used.length === 0) {
      await rm(unitDir, { recursive: true, force: true });
      return fromSource();
    }
    let ir = `${stem}.fe.ll`;
    for (const [i, p] of used.entries()) {
      const merged = `${stem}.${i}.ll`;
      await run(process.execPath, [
        cli,
        join(runtimeSrc, p.unit.source),
        "--probe",
        p.probe,
        "--into",
        ir,
        "-o",
        merged,
        ...(i === 0 ? ["--name-counter", `${stem}.counter.ll`] : []),
      ]);
      ir = merged;
    }
    const link = [];
    if ((await stat(`${stem}.counter.ll`)).size > 0) {
      await run(compiler, [
        ...compilerArgs,
        ...flags,
        "-emit-llvm",
        "-Xclang",
        "-disable-llvm-passes",
        "-c",
        `${stem}.counter.ll`,
        "-o",
        `${stem}.counter.bc`,
      ]);
      link.push("-Xclang", "-mlink-builtin-bitcode", "-Xclang", `${stem}.counter.bc`);
    }
    await run(compiler, [
      ...compilerArgs,
      ...flags,
      ...(bitcode ? ["-emit-llvm"] : []),
      "-c",
      ir,
      ...link,
      "-o",
      output,
    ]);
    await rm(unitDir, { recursive: true, force: true });
  };
}

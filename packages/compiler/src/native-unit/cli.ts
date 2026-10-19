/* `node native-unit/cli.js`: compiles a native unit for the runtime pack
 * build.
 *
 *   cli.js --print-probe                          the probe's C source
 *   cli.js <unit.ts> --probe <probe.ll> -o <out.ll> [--layout-asserts <out.h>] [--shapes <out.h>]
 *   cli.js <unit.ts> --probe <probe.ll> --into <c-unit.ll> -o <out.ll> [--name-counter <out.ll>]
 *
 * The probe is `--print-probe` compiled with a runtime unit's flags up to
 * clang's frontend. `--layout-asserts` also writes the C `_Static_assert`s
 * on the module's struct layouts, and `--shapes` the stand-in bodies the C
 * header defines the module's functions with in a native build. `--into`
 * puts the module's functions into a C unit's frontend IR, compiled with
 * those stand-ins, in their place; `--name-counter`, given to the first
 * module merged into a unit, also writes the module that restores clang's
 * name counter, to link in with `-mlink-builtin-bitcode` (an empty file
 * when the counter needs none). Diagnostics go to stderr, and the exit
 * status is 1 when there are any. */
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { renderDiagnostics } from "../diagnostics/render.js";
import { compileNativeUnit, nativeProbeSource } from "./index.js";

const { values, positionals } = parseArgs({
  options: {
    probe: { type: "string" },
    out: { type: "string", short: "o" },
    into: { type: "string" },
    "layout-asserts": { type: "string" },
    shapes: { type: "string" },
    "name-counter": { type: "string" },
    "print-probe": { type: "boolean", default: false },
  },
  allowPositionals: true,
});

if (values["print-probe"]) {
  process.stdout.write(nativeProbeSource());
} else {
  const entry = positionals[0];
  if (entry === undefined || values.probe === undefined || values.out === undefined) {
    process.stderr.write(
      "usage: native-unit <unit.ts> --probe <probe.ll> [--into <c-unit.ll> [--name-counter <out.ll>]] -o <out.ll> [--layout-asserts <out.h>] [--shapes <out.h>]\n",
    );
    process.exitCode = 2;
  } else {
    const result = compileNativeUnit(entry, {
      probe: readFileSync(values.probe, "utf8"),
      ...(values.into !== undefined ? { into: readFileSync(values.into, "utf8") } : {}),
      shapes: values.shapes !== undefined,
      nameCounter: values["name-counter"] !== undefined,
    });
    if (result.llvm === null) {
      const sources = new Map(
        result.diagnostics.map((d) => [d.loc.file, readFileSync(d.loc.file, "utf8")]),
      );
      process.stderr.write(renderDiagnostics(result.diagnostics, sources) + "\n");
      process.exitCode = 1;
    } else {
      writeFileSync(values.out, result.llvm);
      if (values["layout-asserts"] !== undefined)
        writeFileSync(values["layout-asserts"], result.layoutAsserts!);
      if (values.shapes !== undefined) writeFileSync(values.shapes, result.shapes!);
      if (values["name-counter"] !== undefined)
        writeFileSync(values["name-counter"], result.nameCounter ?? "");
    }
  }
}

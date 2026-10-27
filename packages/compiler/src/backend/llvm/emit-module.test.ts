import { expect, test } from "vitest";
import { type IrModule, VOID } from "../../ir/ir.js";
import { LlEmitter } from "./emitter.js";

const loc = { file: "large-metadata.ts", start: 0, end: 0 };

test.each([false, true])("large field metadata retains its order (library: %s)", (library) => {
  const mod: IrModule = {
    irVersion: 17,
    sourceFile: loc.file,
    entry: "main",
    functions: [{ name: "main", params: [], returnType: VOID, locals: [], body: [], loc }],
  };
  if (library) {
    mod.lib = {
      profileName: "metadata",
      prefix: "metadata_",
      initSymbol: "metadata_init",
      sinkRegisterSymbol: "metadata_sink",
      collectSymbol: null,
      resultResetSymbol: null,
      threadInstances: false,
      exports: [],
      trapOverlays: [],
    };
  }
  const emitter = new LlEmitter(mod, {});
  // Each field produces two metadata lines. Passing this many lines as
  // call arguments exceeds the host's limit even though the module fits.
  for (let i = 0; i < 100_000; i++) emitter.fieldAliasTags.set(`field.${i}`, 2 + i * 2);
  const parts = emitter.emitParts();
  const start = parts.indexOf('!0 = !{!"scriptc native fields"}');
  expect(start).toBeGreaterThanOrEqual(0);
  const metadata = parts.slice(start + 1, start + 200_001);
  expect(metadata).toHaveLength(200_000);
  expect(metadata.slice(0, 2)).toEqual(['!1 = !{!"field.2", !0, i64 0}', "!2 = !{!1, !1, i64 0}"]);
  expect(metadata.slice(-2)).toEqual([
    '!199999 = !{!"field.200000", !0, i64 0}',
    "!200000 = !{!199999, !199999, i64 0}",
  ]);
  expect(metadata.map((line) => Number(/^!(\d+) /.exec(line)?.[1]))).toEqual(
    Array.from({ length: 200_000 }, (_, i) => i + 1),
  );
});

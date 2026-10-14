import { expect, test } from "vitest";
import {
  BOOL,
  F64,
  STRING,
  VOID,
  type IrExpr,
  type IrFunction,
  type IrModule,
  type IrStmt,
  type IrType,
} from "../../ir/ir.js";
import { validateModule } from "../../ir/validate.js";
import { emitLlvmModule } from "./emitter.js";

const loc = { file: "map-iteration.ts", start: 0, end: 1 };
const ref = (localId: string, type: IrType): IrExpr => ({ kind: "varRef", localId, type, loc });

/** work(map, i): the key (or, for `read: "value"`, the value) at a live
 * index, after the walk's start and count reads the for-of desugar makes. */
function fixture(key: IrType, value: IrType, read: "key" | "value"): IrModule {
  const map: IrType = { kind: "map", key, value };
  const step = (method: string, args: IrExpr[], type: IrType): IrExpr =>
    ({ kind: "mapIntrinsic", method, receiver: ref("map", map), args, type, loc }) as IrExpr;
  const result = read === "key" ? key : value;
  const body: IrStmt[] = [
    { kind: "varDecl", localId: "start", init: step("iterStart", [], F64), loc },
    { kind: "varDecl", localId: "count", init: step("iterCount", [], F64), loc },
    {
      kind: "if",
      cond: step("iterLive", [ref("i", F64)], BOOL),
      then: [
        {
          kind: "return",
          value: step(read === "key" ? "iterKey" : "iterValue", [ref("i", F64)], result),
          loc,
        },
      ],
      else_: null,
      loc,
    },
    {
      kind: "return",
      value: step(read === "key" ? "iterKey" : "iterValue", [ref("start", F64)], result),
      loc,
    },
  ];
  const params = [
    { localId: "map", name: "map", type: map },
    { localId: "i", name: "i", type: F64 },
  ];
  const work: IrFunction = {
    name: "work",
    params,
    returnType: result,
    loc,
    locals: [
      ...params.map((p) => ({ id: p.localId, name: p.name, type: p.type, mutable: true })),
      { id: "start", name: "start", type: F64, mutable: false },
      { id: "count", name: "count", type: F64, mutable: false },
    ],
    body,
  };
  return {
    irVersion: 16,
    sourceFile: loc.file,
    entry: "main",
    records: [],
    unions: [],
    functions: [{ name: "main", params: [], locals: [], returnType: VOID, body: [], loc }, work],
  };
}

function emitted(mod: IrModule, bits: 32 | 64): { work: string; module: string } {
  expect(validateModule(mod)).toEqual([]);
  const module = emitLlvmModule(mod, { pointerBits: bits });
  const work = /^define internal [^\n]*@sc_(?:b)?f_work(?:\.i32)?\([^]*?^}/m.exec(module)![0];
  return { work, module };
}

test("iteration steps read the entries array inline on both ABIs", () => {
  for (const bits of [32, 64] as const) {
    const sz = bits === 64 ? "i64" : "i32";
    const { work, module } = emitted(fixture(STRING, F64, "value"), bits);
    // Field 9 is the entry count and 13 the entries array; a zero hash
    // (entry field 2) marks a tombstone.
    expect(module).toMatch(/^define internal ptr @sc_map_iter_entry\(ptr %m, double %i\)/m);
    expect(module).toContain(`getelementptr inbounds %ScrMapIx, ptr %m, i32 0, i32 9`);
    expect(module).toContain(`getelementptr inbounds %ScrMapIx, ptr %m, i32 0, i32 13`);
    expect(module).toContain(`getelementptr inbounds %ScrMapEntry, ptr %e, i32 0, i32 2`);
    expect(module).toContain(`%n = load ${sz}, ptr %np`);
    // The walk's start comes from the runtime, which skips a deleted prefix.
    expect(work).toContain("call double @scr_map_iter_start(");
    expect(work).toContain("call double @sc_map_iter_count(");
    expect(work).toContain("call ptr @sc_map_iter_entry(");
    expect(work).not.toContain("@scr_map_iter_live");
    expect(work).not.toContain("@scr_map_iter_count");
    // The value loads from field 1 of a live entry; the runtime accessor is
    // only the fallback for an index the guard excludes.
    expect(work).toContain("getelementptr inbounds %ScrMapEntry, ptr");
    expect(work).toMatch(/i32 0, i32 1\n\s+%t\d+ = load double/);
    expect(work).toContain("call double @scr_map_iter_val_f64(");
  }
});

test("string keys and reference values are retained inline, boolean slots compare against zero", () => {
  const key = emitted(fixture(STRING, F64, "key"), 64).work;
  expect(key).toMatch(/i32 0, i32 0\n\s+%t\d+ = load ptr/);
  expect(key).toContain("@scr_str_retain");
  expect(key).toContain("call ptr @scr_map_iter_key_str(");

  const flag = emitted(fixture(F64, BOOL, "value"), 64).work;
  expect(flag).toMatch(/load i64, ptr %t\d+\n\s+%t\d+ = icmp ne i64 %t\d+, 0/);
  expect(flag).toContain("call i1 @scr_map_iter_val_bool(");

  const text = emitted(fixture(F64, STRING, "value"), 64).work;
  expect(text).toContain("@scr_str_retain");
  expect(text).toContain("call ptr @scr_map_iter_val_ref(");
});

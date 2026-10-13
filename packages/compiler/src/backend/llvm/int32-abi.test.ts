import { expect, test } from "vitest";
import {
  BOOL,
  F64,
  STRING,
  VOID,
  funcOf,
  type IrExpr,
  type IrFunction,
  type IrModule,
  type IrStmt,
} from "../../ir/ir.js";
import { validateModule } from "../../ir/validate.js";
import { emitLlvmModule } from "./emitter.js";

const loc = { file: "int32-abi.ts", start: 0, end: 0 };
const num = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });
const ref = (localId: string): IrExpr => ({ kind: "varRef", localId, type: F64, loc });
const bin = (op: "|" | "*" | "^", left: IrExpr, right: IrExpr): IrExpr => ({
  kind: "bin",
  op,
  left,
  right,
  type: F64,
  loc,
});
const call = (callee: string, args: IrExpr[], type = F64): IrExpr => ({
  kind: "call",
  callee,
  args,
  type,
  loc,
});
const stmt = (expr: IrExpr): IrStmt => ({ kind: "exprStmt", expr, loc });
const ret = (value: IrExpr): IrStmt => ({ kind: "return", value, loc });
function fn(name: string, params: string[], body: IrStmt[], returnType = F64): IrFunction {
  return {
    name,
    params: params.map((id) => ({ localId: id, name: id, type: F64 })),
    locals: params.map((id) => ({ id, name: id, type: F64, mutable: true })),
    returnType,
    body,
    loc,
  };
}

function module(): IrModule {
  return {
    irVersion: 16,
    sourceFile: loc.file,
    entry: "main",
    functions: [
      fn(
        "main",
        [],
        [
          stmt(call("mix", [num(3), num(4)])),
          stmt(call("half", [num(6)])),
          stmt(call("bits", [num(5)])),
          stmt({ kind: "closure", fnName: "bits", captures: [], type: funcOf([F64], F64), loc }),
          stmt(call("checked", [num(2)])),
          stmt(call("leaf", [num(9)])),
        ],
        VOID,
      ),
      // int32 parameters and result.
      fn("mix", ["h", "i"], [ret(bin("|", bin("^", ref("h"), ref("i")), num(0)))]),
      // int32 parameter, number result.
      fn("half", ["n"], [ret(bin("*", ref("n"), num(0.5)))]),
      // Escapes as a value: its parameter is unknown, its result int32.
      fn("bits", ["n"], [ret(bin("|", ref("n"), num(0)))]),
      // Returns its parameter as a number result: the parameter stays double.
      fn(
        "leaf",
        ["n"],
        [
          {
            kind: "if",
            cond: { kind: "bin", op: "<", left: ref("n"), right: num(2), type: BOOL, loc },
            then: [ret(ref("n"))],
            else_: [ret(bin("*", ref("n"), num(0.5)))],
            loc,
          },
        ],
      ),
      // A throwing call inside an i32 body.
      fn("checked", ["n"], [stmt(call("throws", [], VOID)), ret(bin("|", ref("n"), num(1)))]),
      fn(
        "throws",
        [],
        [{ kind: "throw", value: { kind: "strLit", value: "no", type: STRING, loc }, loc }],
        VOID,
      ),
    ],
  };
}

function define(llvm: string, symbol: string): string {
  const escaped = symbol.replace(/\./g, "\\.");
  return new RegExp(`^define internal [^\\n]*@${escaped}\\([^]*?^}`, "m").exec(llvm)![0];
}

test("int32 parameters and results use an i32 entry on direct calls", () => {
  const mod = module();
  expect(validateModule(mod)).toEqual([]);
  const llvm = emitLlvmModule(mod);
  expect(llvm).toMatch(/define internal i32 @sc_f_mix\.i32\(i32 %p_\w+\.i32, i32 %p_\w+\.i32\)/);
  expect(llvm).toMatch(/define internal double @sc_f_half\.i32\(i32 %p_\w+\.i32\)/);
  expect(llvm).toMatch(/define internal i32 @sc_f_bits\.i32\(double %p_\w+\)/);
  const main = define(llvm, "sc_f_main");
  expect(main).toContain("call i32 @sc_f_mix.i32(i32 3, i32 4)");
  expect(main).toContain("call double @sc_f_half.i32(i32 6)");
  expect(main).toContain("call i32 @sc_f_bits.i32(double ");
  expect(main).toContain("call double @sc_f_leaf(double ");
  expect(llvm).not.toContain("@sc_f_leaf.i32");
  // The closure keeps the double-ABI symbol, a wrapper around the i32 entry.
  expect(llvm).not.toMatch(/ptr @sc_f_bits\.i32\b/);
  const wrapper = define(llvm, "sc_f_mix");
  expect(wrapper).toContain("define internal double @sc_f_mix(double %p0, double %p1)");
  expect(wrapper).toContain("%a0 = fptosi double %p0 to i32");
  expect(wrapper).toContain("%r = call i32 @sc_f_mix.i32(i32 %a0, i32 %a1)");
  expect(wrapper).toContain("%d = sitofp i32 %r to double");
  // The exceptional exit of an i32 body returns an i32.
  const checked = define(llvm, "sc_f_checked.i32");
  expect(checked).toContain("ret i32 0");
  expect(checked).not.toContain("ret double");
});

test("debug builds keep the double ABI", () => {
  const llvm = emitLlvmModule(module(), {
    debugSources: new Map([[loc.file, "function main() {}"]]),
  });
  expect(llvm).not.toContain(".i32(");
  expect(llvm).toMatch(/define internal double @sc_f_mix\(double %p_\w+, double %p_\w+\)/);
});

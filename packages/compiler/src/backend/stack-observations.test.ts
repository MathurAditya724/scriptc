import { expect, test } from "vitest";
import {
  F64,
  STRING,
  VOID,
  type IrExpr,
  type IrFunction,
  type IrModule,
  type IrStmt,
} from "../ir/ir.js";
import { captureFreeFunctions, observesStacks } from "./stack-observations.js";

const loc = { file: "stack-observations.ts", start: 0, end: 0 };
const ERROR = { kind: "object", className: "%Error" } as const;
const err: IrExpr = { loc, kind: "varRef", localId: "e", type: ERROR };
const stackRead: IrStmt = {
  loc,
  kind: "exprStmt",
  expr: { loc, kind: "libCall", fn: "error.stack", args: [err], type: STRING },
};
const call = (callee: string): IrStmt => ({
  loc,
  kind: "exprStmt",
  expr: { loc, kind: "call", callee, args: [], type: VOID },
});
const throwStmt: IrStmt = { loc, kind: "throw", value: err };
const ret: IrStmt = { loc, kind: "return", value: null };
const fn = (name: string, body: IrStmt[]): IrFunction => ({
  loc,
  name,
  params: [],
  locals: [],
  returnType: VOID,
  body,
});
const mod = (functions: IrFunction[], extra: Partial<IrModule> = {}): IrModule => ({
  irVersion: 17,
  sourceFile: "stack-observations.ts",
  entry: "%main",
  functions,
  classes: [],
  records: [],
  unions: [],
  globals: [],
  ...extra,
});

test("a reachable stack read is observed", () => {
  expect(observesStacks(mod([fn("%main", [call("parse")]), fn("parse", [stackRead])]))).toBe(true);
});

test("programs without stack reads are not", () => {
  expect(observesStacks(mod([fn("%main", [call("helper")]), fn("helper", [ret])]))).toBe(false);
});

test("reads after an unconditional throw or return never run", () => {
  expect(observesStacks(mod([fn("%main", [throwStmt, stackRead])]))).toBe(false);
  expect(observesStacks(mod([fn("%main", [ret, call("parse")]), fn("parse", [stackRead])]))).toBe(
    false,
  );
  // A terminator ends only its own list: the outer list continues.
  const cond: IrExpr = { loc, kind: "numLit", value: 1, type: F64 };
  expect(
    observesStacks(
      mod([fn("%main", [{ kind: "if", cond, then: [ret], else_: null, loc }, stackRead])]),
    ),
  ).toBe(true);
});

test("functions referenced only from dead code are unreached", () => {
  // The production React shape: a DEV-only body behind a throw stub calls
  // the stack parser, and a closure created after the stub reaches it too.
  const closure: IrStmt = {
    loc,
    kind: "assign",
    localId: "replacer",
    value: {
      loc,
      kind: "closure",
      fnName: "replacer",
      captures: [],
      type: { kind: "func", params: [], ret: VOID },
    },
  };
  const program = mod([
    fn("%main", [call("outline")]),
    fn("outline", [throwStmt, closure, call("parse")]),
    fn("replacer", [call("parse")]),
    fn("parse", [stackRead]),
  ]);
  expect(observesStacks(program)).toBe(false);
  // The same closure created before the stub keeps the read reachable.
  const live = mod([
    fn("%main", [call("outline")]),
    fn("outline", [closure, throwStmt]),
    fn("replacer", [call("parse")]),
    fn("parse", [stackRead]),
  ]);
  expect(observesStacks(live)).toBe(true);
});

test("class methods are roots", () => {
  const program = mod([fn("%main", [ret]), fn("%Parser.read", [stackRead])], {
    classes: [
      { name: "Parser", fields: [], methods: ["read"] } as unknown as NonNullable<
        IrModule["classes"]
      >[number],
    ],
  });
  expect(observesStacks(program)).toBe(true);
});

test("leaf functions that cannot create an Error need no frame", () => {
  const num = (value: number): IrExpr => ({ loc, kind: "numLit", value, type: F64 });
  const add: IrStmt = {
    loc,
    kind: "return",
    value: { loc, kind: "bin", op: "+", left: num(1), right: num(2), type: F64 },
  };
  const construct: IrStmt = {
    loc,
    kind: "exprStmt",
    expr: { loc, kind: "libCall", fn: "error.new", args: [], type: ERROR },
  };
  const program = mod([
    fn("%main", [call("leaf"), call("caller"), call("creates"), call("viaCreates")]),
    fn("leaf", [add]),
    fn("caller", [call("leaf"), add]),
    fn("creates", [construct]),
    fn("viaCreates", [call("creates")]),
    fn("recursive", [call("recursive")]),
  ]);
  const free = captureFreeFunctions(program, new Set(["recursive"]), null);
  expect([...free].sort()).toEqual(["caller", "leaf"]);
  // A worker program keeps every frame.
  expect(captureFreeFunctions({ ...program, workers: true }, null, null).size).toBe(0);
});

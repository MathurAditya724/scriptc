import { expect, test } from "vitest";
import { BOOL, F64, arrayOf, type IrExpr, type IrLocal, type IrStmt } from "../../ir/ir.js";
import {
  countedDenseShape,
  matchDenseArrayLoop,
  type DenseLoopShape,
} from "./dense-array-loops.js";

const loc = { file: "dense-array-loops.ts", start: 0, end: 0 };
const ARR = arrayOf(F64);
const num = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });
const ref = (localId: string): IrExpr => ({ kind: "varRef", localId, type: F64, loc });
const arr = (localId: string): IrExpr & { kind: "varRef" } => ({
  kind: "varRef",
  localId,
  type: ARR,
  loc,
});
const method = (
  receiver: string,
  name: Extract<IrExpr, { kind: "arrIntrinsic" }>["method"],
  args: IrExpr[] = [],
): IrExpr => ({
  kind: "arrIntrinsic",
  method: name,
  receiver: arr(receiver),
  args,
  type: F64,
  loc,
});
const read = (receiver: string, index = ref("i")): IrExpr => method(receiver, "getNumber", [index]);
const write = (receiver: string, value: IrExpr, index = ref("i")): IrStmt => ({
  kind: "arraySet",
  arr: arr(receiver),
  index,
  value,
  loc,
});
const locals = new Map<string, IrLocal>([
  ["i", { id: "i", name: "i", type: F64, mutable: true }],
  ["a", { id: "a", name: "a", type: ARR, mutable: false }],
  ["b", { id: "b", name: "b", type: ARR, mutable: true }],
  ["c", { id: "c", name: "c", type: ARR, mutable: false }],
]);

/** for (let i = 0; i < a.length; i++) body */
function loop(body: IrStmt[]): IrStmt & { kind: "for" } {
  return {
    kind: "for",
    loc,
    init: { kind: "varDecl", localId: "i", init: num(0), loc },
    cond: { kind: "bin", op: "<", left: ref("i"), right: method("a", "length"), type: BOOL, loc },
    update: {
      kind: "assign",
      localId: "i",
      value: { kind: "bin", op: "+", left: ref("i"), right: num(1), type: F64, loc },
      loc,
    },
    body,
  };
}
const shape: DenseLoopShape = {
  counter: "i",
  length: arr("a"),
  range: { min: 0, max: 4294967294 },
};
const match = (body: IrStmt[], initialized = new Set(["a", "b"])) =>
  matchDenseArrayLoop(loop(body), shape, locals, new Set(), initialized);

test("arrays indexed at the counter of a length-preserving loop get an int32 fast copy", () => {
  const scale = write("b", {
    kind: "bin",
    op: "*",
    left: read("a"),
    right: num(2),
    type: F64,
    loc,
  });
  const dense = match([scale]);
  expect([...dense!.arrays.keys()].sort()).toEqual(["a", "b"]);
  expect(dense!.range).toEqual({ min: 0, max: 2147483646 });
  // A binding not definitely assigned before the loop is not read by the guard.
  expect([...match([scale], new Set())!.arrays.keys()]).toEqual(["a"]);
});

test("loops that may resize, rebind or move storage keep the ordinary copy only", () => {
  expect(match([{ kind: "exprStmt", expr: method("a", "push", [num(1)]), loc }])).toBeNull();
  expect(match([write("a", num(0), ref("unknown"))])).toBeNull();
  expect(
    match([
      { kind: "exprStmt", expr: { kind: "call", callee: "f", args: [], type: F64, loc }, loc },
    ]),
  ).toBeNull();
  // A nested loop would be duplicated too.
  expect(match([{ kind: "exprStmt", expr: read("a"), loc }, loop([])])).toBeNull();
  // No access at the counter: nothing to prove.
  expect(match([{ kind: "exprStmt", expr: read("a", num(0)), loc }])).toBeNull();
  // Copying the bounding array into another binding lets it escape.
  expect(
    match([
      { kind: "exprStmt", expr: read("a"), loc },
      { kind: "assign", localId: "b", value: arr("a"), loc },
    ]),
  ).toBeNull();
  // A rebound array is not covered, but the bounding array still is.
  const rebound = match([
    { kind: "exprStmt", expr: read("b"), loc },
    { kind: "exprStmt", expr: read("a"), loc },
    { kind: "assign", localId: "b", value: arr("c"), loc },
  ]);
  expect([...rebound!.arrays.keys()]).toEqual(["a"]);
});

test("counted shapes need a non-negative counter strictly below the length", () => {
  const ascending = (limit: IrExpr, inclusive: boolean, min = 0) =>
    countedDenseShape(loop([]), {
      localId: "i",
      start: num(min),
      limit,
      step: 1,
      inclusive,
      range: { min, max: 100 },
    });
  const minus = (offset: number): IrExpr => ({
    kind: "bin",
    op: "-",
    left: method("a", "length"),
    right: num(offset),
    type: F64,
    loc,
  });
  expect(ascending(method("a", "length"), false)?.length.localId).toBe("a");
  expect(ascending(minus(1), true)?.length.localId).toBe("a");
  expect(ascending(method("a", "length"), true)).toBeNull();
  expect(ascending(minus(1), false, -1)).toBeNull();
  const descending = (offset: number) =>
    countedDenseShape(loop([]), {
      localId: "i",
      start: minus(offset),
      limit: num(0),
      step: -1,
      inclusive: true,
      range: { min: 0, max: 100 },
    });
  expect(descending(1)?.length.localId).toBe("a");
  expect(descending(0)).toBeNull();
});

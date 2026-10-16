import { expect, test } from "vitest";
import { F64, type IrExpr, type IrStmt } from "../../ir/ir.js";
import {
  isSpeculableValue,
  planSpeculativeLoop,
  speculativeReads,
} from "./speculative-integers.js";

const loc = { file: "speculative.ts", start: 0, end: 0 };
const num = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });
const ref = (localId: string): IrExpr => ({ kind: "varRef", localId, type: F64, loc });
const bin = (op: "+" | "-" | "*" | "/" | "%" | "<" | "|", left: IrExpr, right: IrExpr): IrExpr => ({
  kind: "bin",
  op,
  left,
  right,
  type: op === "<" ? { kind: "bool" } : F64,
  loc,
});
const assign = (localId: string, value: IrExpr): IrStmt => ({
  kind: "assign",
  localId,
  value,
  loc,
});
const increment = (localId: string): IrStmt => ({
  kind: "exprStmt",
  expr: { kind: "incDec", op: "+", prefix: false, localId, type: F64, loc },
  loc,
});
const loop = (body: IrStmt[], cond: IrExpr = bin("<", ref("i"), ref("n"))): IrStmt => ({
  kind: "while",
  cond,
  body,
  loc,
});
const all = (): boolean => true;

test("integer writes and their loop-invariant inputs are speculated", () => {
  const write = assign(
    "v",
    bin("%", bin("+", bin("*", ref("v"), num(31)), ref("k")), num(1000003)),
  );
  const step = increment("i");
  const plan = planSpeculativeLoop(loop([write, step]) as never, all)!;
  expect(plan.writes).toEqual(new Set([write, step]));
  // `n` (condition) and `k` (write input) are invariant and checked on entry.
  expect([...plan.locals]).toEqual([
    ["v", true],
    ["i", true],
    ["k", true],
    ["n", true],
  ]);
});

test("locals declared in the body need no entry check", () => {
  const declare: IrStmt = { kind: "varDecl", localId: "t", init: bin("*", ref("i"), num(2)), loc };
  const plan = planSpeculativeLoop(
    loop([
      declare,
      assign("s", bin("%", bin("*", ref("s"), ref("t")), num(65521))),
      increment("i"),
    ]) as never,
    all,
  )!;
  expect(plan.locals.get("t")).toBe(false);
  expect(plan.locals.get("s")).toBe(true);
});

test("non-integer, expression-position and ineligible writes keep the double copy", () => {
  expect(isSpeculableValue(bin("/", ref("a"), num(2)))).toBe(false);
  expect(isSpeculableValue(num(0.5))).toBe(false);
  expect(isSpeculableValue(num(-0))).toBe(false);
  expect(isSpeculableValue(bin("|", ref("a"), num(0)))).toBe(true);
  // A fractional write leaves only the counter, which alone is not worth a copy.
  const halves = loop([assign("x", bin("/", ref("x"), num(2))), increment("i")]);
  expect(planSpeculativeLoop(halves as never, all)?.locals.has("x")).toBeFalsy();
  // A write inside a sequence expression cannot restart its statement.
  const sequence: IrStmt = {
    kind: "exprStmt",
    expr: {
      kind: "seqExpr",
      stmts: [assign("v", bin("+", ref("v"), num(1)))],
      result: num(0),
      type: F64,
      loc,
    },
    loc,
  };
  const plan = planSpeculativeLoop(
    loop([sequence, assign("v", bin("+", ref("v"), num(2))), increment("i")]) as never,
    all,
  );
  expect(plan?.locals.has("v")).toBeFalsy();
  expect(
    planSpeculativeLoop(
      loop([assign("v", bin("+", ref("v"), num(2)))]) as never,
      (id) => id !== "v",
    ),
  ).toBeNull();
});

test("accumulators that are only added to keep their double", () => {
  const sum = loop([assign("s", bin("+", ref("s"), bin("%", ref("i"), num(7)))), increment("i")]);
  expect(planSpeculativeLoop(sum as never, all)?.locals.has("s")).toBeFalsy();
});

test("nested loops are left to the inner loop", () => {
  const inner = loop([assign("v", bin("+", ref("v"), num(1)))]);
  expect(planSpeculativeLoop(loop([inner, increment("i")]) as never, all)).toBeNull();
});

test("statically proven locals are never shadowed and leave nothing to duplicate", () => {
  const write = assign(
    "v",
    bin("%", bin("+", bin("*", ref("v"), num(31)), ref("k")), num(1000003)),
  );
  const body = [write, increment("i")];
  // Every read proven: no plan at all.
  expect(
    planSpeculativeLoop(
      loop(body) as never,
      all,
      () => false,
      () => true,
    ),
  ).toBeNull();
  // Only `k` proven: `v` and the counter are shadowed, `k` is not checked.
  const plan = planSpeculativeLoop(
    loop(body) as never,
    all,
    () => false,
    (e) => e.kind === "varRef" && e.localId === "k",
  )!;
  expect(plan.locals.has("v")).toBe(true);
  expect(plan.locals.has("k")).toBe(false);
});

test("heap reads are speculative leaves, read before any check", () => {
  const rows: IrExpr = {
    kind: "varRef",
    localId: "rows",
    type: { kind: "array", elem: F64 },
    loc,
  } as never;
  const element: IrExpr = { kind: "arrayGet", arr: rows, index: ref("i"), type: F64, loc };
  const text: IrExpr = { kind: "varRef", localId: "s", type: { kind: "string" }, loc } as never;
  const code: IrExpr = {
    kind: "strIntrinsic",
    method: "charCodeAt",
    receiver: text,
    args: [ref("i")],
    type: F64,
    loc,
  } as never;
  const value = bin("%", bin("+", bin("*", ref("h"), num(33)), code), num(2147483647));
  expect(isSpeculableValue(value)).toBe(true);
  expect(speculativeReads(bin("+", element, code))).toEqual([element, code]);
  // The ordinary emitter evaluates bitwise operators; heap reads stay out.
  expect(isSpeculableValue(bin("|", code, num(0)))).toBe(false);
  const eligible = (id: string): boolean => id !== "rows" && id !== "s";
  const plan = planSpeculativeLoop(loop([assign("h", value), increment("i")]) as never, eligible)!;
  expect(plan.locals.has("h")).toBe(true);
});

test("invariants may come from bindings no shadow could be written to", () => {
  const write = assign("h", bin("%", bin("+", bin("*", ref("h"), num(33)), ref("i")), ref("m")));
  const body = [write, increment("i")];
  const locals = (id: string): boolean => id !== "m";
  expect(planSpeculativeLoop(loop(body) as never, locals)?.locals.has("h")).toBeFalsy();
  const plan = planSpeculativeLoop(
    loop(body) as never,
    locals,
    () => false,
    () => false,
    all,
  )!;
  expect(plan.locals.get("m")).toBe(true);
  expect(plan.locals.has("h")).toBe(true);
});

test("loops that only count and compare keep one copy", () => {
  const counter = loop([increment("i")]);
  expect(planSpeculativeLoop(counter as never, all)).toBeNull();
  // A variable step (a sieve's `j += i`) is worth a copy.
  const sieve = loop([assign("i", bin("+", ref("i"), ref("step")))]);
  expect(planSpeculativeLoop(sieve as never, all)?.locals.has("i")).toBe(true);
  const scaled = loop([
    assign("j", bin("+", ref("j"), bin("*", ref("i"), ref("n")))),
    increment("i"),
  ]);
  expect(planSpeculativeLoop(scaled as never, all)?.locals.has("n")).toBe(true);
});

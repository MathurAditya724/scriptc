import { expect, test } from "vitest";
import { F64, type IrExpr, type IrStmt } from "../../ir/ir.js";
import { isSpeculableValue, planSpeculativeLoop } from "./speculative-integers.js";

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
  expect(planSpeculativeLoop(halves as never, all)?.locals.has("x")).toBe(false);
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
  expect(plan?.locals.has("v")).toBe(false);
  expect(
    planSpeculativeLoop(
      loop([assign("v", bin("+", ref("v"), num(2)))]) as never,
      (id) => id !== "v",
    ),
  ).toBeNull();
});

test("accumulators that are only added to keep their double", () => {
  const sum = loop([assign("s", bin("+", ref("s"), bin("%", ref("i"), num(7)))), increment("i")]);
  expect(planSpeculativeLoop(sum as never, all)?.locals.has("s")).toBe(false);
});

test("nested loops are left to the inner loop", () => {
  const inner = loop([assign("v", bin("+", ref("v"), num(1)))]);
  expect(planSpeculativeLoop(loop([inner, increment("i")]) as never, all)).toBeNull();
});

import { expect, test } from "vitest";
import { inlineArrayReads, planInlineArrays } from "./inline-arrays.js";
import {
  F64,
  VOID,
  type IrClassDef,
  type IrExpr,
  type IrFunction,
  type IrModule,
  type IrStmt,
  type IrType,
} from "./ir.js";

const loc = { file: "inline-arrays.ts", start: 0, end: 0 };
const obj = (className: string): IrType => ({ kind: "object", className });
const ITEMS: IrType = { kind: "array", elem: obj("Item") };
const ref = (localId: string, type: IrType): IrExpr => ({ loc, kind: "varRef", localId, type });
const set = (target: IrExpr, className: string, field: string, value: IrExpr): IrStmt => ({
  loc,
  kind: "fieldSet",
  obj: target,
  className,
  field,
  value,
});
const get = (target: IrExpr, className: string, field: string, type: IrType): IrExpr => ({
  loc,
  kind: "fieldGet",
  obj: target,
  className,
  field,
  type,
});
const fn = (
  name: string,
  params: { id: string; type: IrType }[],
  body: IrStmt[],
  locals: { id: string; type: IrType; mutable?: boolean }[] = [],
): IrFunction => ({
  loc,
  name,
  params: params.map((p) => ({ localId: p.id, name: p.id, type: p.type })),
  locals: [...params, ...locals].map((l) => ({
    id: l.id,
    name: l.id,
    type: l.type,
    mutable: "mutable" in l ? l.mutable === true : false,
  })),
  returnType: VOID,
  body,
});
const cls = (name: string, fields: [string, IrType][], base?: string): IrClassDef => ({
  loc,
  name,
  ...(base ? { base } : {}),
  fields: fields.map(([field, type]) => ({ name: field, type })),
});
const listFields: [string, IrType][] = [
  ["pos", F64],
  ["items", ITEMS],
];
const listCtor = fn(
  "%List.constructor",
  [
    { id: "this", type: obj("List") },
    { id: "pos", type: F64 },
    { id: "items", type: ITEMS },
  ],
  [
    set(ref("this", obj("List")), "List", "pos", ref("pos", F64)),
    set(ref("this", obj("List")), "List", "items", ref("items", ITEMS)),
  ],
);
// `class Flagged extends List { constructor(items, flags, pos) { super(pos, items) } }`.
const flaggedCtor = fn(
  "%Flagged.constructor",
  [
    { id: "this", type: obj("Flagged") },
    { id: "nodes", type: ITEMS },
    { id: "flags", type: F64 },
    { id: "pos", type: F64 },
  ],
  [
    {
      loc,
      kind: "exprStmt",
      expr: {
        loc,
        kind: "call",
        callee: "%List.constructor",
        args: [
          { loc, kind: "upcast", value: ref("this", obj("Flagged")), type: obj("List") },
          ref("pos", F64),
          ref("nodes", ITEMS),
        ],
        type: VOID,
      },
    },
    set(ref("this", obj("Flagged")), "Flagged", "flags", ref("flags", F64)),
  ],
);
const itemCtor = fn("%Item.constructor", [{ id: "this", type: obj("Item") }], []);
const mod = (functions: IrFunction[], extra: IrClassDef[] = []): IrModule => ({
  irVersion: 17,
  sourceFile: "inline-arrays.ts",
  entry: "%main",
  classes: [
    cls("Item", []),
    cls("List", listFields),
    cls("Flagged", [...listFields, ["flags", F64]], "List"),
    ...extra,
  ],
  functions: [fn("%main", [], []), itemCtor, listCtor, flaggedCtor, ...functions],
  records: [],
  unions: [],
  globals: [],
  contracts: { programLifetime: ["Item", "List"], inlineArrays: ["List\0items"] },
});
const lifetime = (name: string): boolean =>
  name === "Item" || name === "List" || name === "Flagged";

test("a subtree is planned with the argument each class takes its length from", () => {
  const plan = planInlineArrays(mod([]), lifetime);
  expect(plan.rejected).toEqual([]);
  expect(plan.classes.get("List")).toMatchObject({ field: "items", fieldIndex: 1, lengthArg: 1 });
  // Flagged passes its first parameter where List takes the array.
  expect(plan.classes.get("Flagged")).toMatchObject({ fieldIndex: 1, lengthArg: 0 });
});

test("other writes, class values and dynamic values keep an ordinary field", () => {
  const conditional = mod([]);
  conditional.functions = conditional.functions.map((f) =>
    f.name !== "%List.constructor"
      ? f
      : {
          ...f,
          body: [
            {
              loc,
              kind: "if",
              cond: { loc, kind: "boolLit", value: true, type: { kind: "bool" } },
              then: [set(ref("this", obj("List")), "List", "items", ref("items", ITEMS))],
              else_: null,
            },
          ],
        },
  );
  expect(planInlineArrays(conditional, lifetime).rejected[0]?.reason).toContain("conditionally");

  const rewritten = mod([
    fn(
      "%List.reset",
      [
        { id: "this", type: obj("List") },
        { id: "other", type: ITEMS },
      ],
      [set(ref("this", obj("List")), "List", "items", ref("other", ITEMS))],
    ),
  ]);
  expect(planInlineArrays(rewritten, lifetime).rejected[0]?.reason).toContain(
    "outside the constructor",
  );

  const value = mod([
    fn(
      "%use",
      [],
      [
        {
          loc,
          kind: "exprStmt",
          expr: { loc, kind: "classRef", className: "Flagged", type: { kind: "dyn" } },
        },
      ],
    ),
  ]);
  expect(planInlineArrays(value, lifetime).rejected[0]?.reason).toContain("used as a value");

  const dynamic = mod([
    fn(
      "%show",
      [{ id: "list", type: obj("List") }],
      [
        {
          loc,
          kind: "exprStmt",
          expr: { loc, kind: "dynFrom", value: ref("list", obj("List")), type: { kind: "dyn" } },
        },
      ],
    ),
  ]);
  expect(planInlineArrays(dynamic, lifetime).rejected[0]?.reason).toContain("dynamic value");
});

test("an alias that only indexes the field reads the field", () => {
  const read: IrExpr = {
    loc,
    kind: "arrayGet",
    arr: ref("nodes", ITEMS),
    index: { loc, kind: "numLit", value: 0, type: F64 },
    type: obj("Item"),
  };
  const sum = fn(
    "%sum",
    [{ id: "list", type: obj("List") }],
    [
      {
        loc,
        kind: "varDecl",
        localId: "nodes",
        init: get(ref("list", obj("List")), "List", "items", ITEMS),
      },
      { loc, kind: "exprStmt", expr: read },
      {
        loc,
        kind: "exprStmt",
        expr: {
          loc,
          kind: "arrIntrinsic",
          method: "length",
          receiver: ref("nodes", ITEMS),
          args: [],
          type: F64,
        },
      },
    ],
    [{ id: "nodes", type: ITEMS }],
  );
  const m = mod([sum]);
  const out = inlineArrayReads(m, planInlineArrays(m, lifetime)).functions.find(
    (f) => f.name === "%sum",
  )!;
  const text = JSON.stringify(out.body);
  // The alias is gone: its reads read the field through the parameter.
  expect(text).not.toContain('"localId":"nodes"');
  expect(text).toContain('"kind":"fieldGet"');
  expect(out.body[0]).toMatchObject({ kind: "block", body: [] });
});

test("an alias that escapes stays an array local", () => {
  const sum = fn(
    "%keep",
    [{ id: "list", type: obj("List") }],
    [
      {
        loc,
        kind: "varDecl",
        localId: "nodes",
        init: get(ref("list", obj("List")), "List", "items", ITEMS),
      },
      { loc, kind: "return", value: ref("nodes", ITEMS) },
    ],
    [{ id: "nodes", type: ITEMS }],
  );
  const m = mod([sum]);
  const out = inlineArrayReads(m, planInlineArrays(m, lifetime));
  expect(out.functions.find((f) => f.name === "%keep")).toBe(sum);
});

test("new evaluates its arguments into locals before allocating", () => {
  const literal: IrExpr = { loc, kind: "arrayLit", elems: [], type: ITEMS };
  const build = fn(
    "%build",
    [],
    [
      {
        loc,
        kind: "exprStmt",
        expr: {
          loc,
          kind: "new",
          className: "List",
          args: [{ loc, kind: "numLit", value: 1, type: F64 }, literal],
          type: obj("List"),
        },
      },
    ],
  );
  const m = mod([build]);
  const out = inlineArrayReads(m, planInlineArrays(m, lifetime)).functions.find(
    (f) => f.name === "%build",
  )!;
  const stmt = out.body[0] as IrStmt & { kind: "exprStmt" };
  expect(stmt.expr.kind).toBe("seqExpr");
  const seq = stmt.expr as IrExpr & { kind: "seqExpr" };
  expect(seq.stmts.map((s) => s.kind)).toEqual(["varDecl", "varDecl"]);
  const made = seq.result as IrExpr & { kind: "new" };
  expect(made.args.every((a) => a.kind === "varRef")).toBe(true);
  expect(out.locals.filter((l) => l.id.startsWith("%inl.arg"))).toHaveLength(2);
});

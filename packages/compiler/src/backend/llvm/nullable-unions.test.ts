import { expect, test } from "vitest";
import {
  F64,
  NULL_T,
  UNDEFINED_T,
  type IrModule,
  type IrType,
  type IrUnionDef,
} from "../../ir/ir.js";
import { NullableUnions } from "./nullable-unions.js";

const loc = { file: "nullable-unions.ts", start: 0, end: 0 };
const a: IrType = { kind: "record", shapeId: "a" };
const b: IrType = { kind: "record", shapeId: "b" };
const c: IrType = { kind: "record", shapeId: "c" };

function module(unions: IrUnionDef[], extra: Partial<IrModule> = {}): IrModule {
  return {
    irVersion: 16,
    sourceFile: loc.file,
    entry: "main",
    records: ["a", "b", "c"].map((id) => ({ id, fields: [{ name: id, type: F64 }] })),
    unions,
    functions: [],
    ...extra,
  };
}

test("unions of two or more records become shape unions", () => {
  const unions = new NullableUnions(
    module([
      { id: "ab", arms: [a, b] },
      { id: "abu", arms: [a, UNDEFINED_T, b] },
      { id: "abnu", arms: [a, b, NULL_T, UNDEFINED_T] },
      { id: "af", arms: [a, F64] },
      { id: "au", arms: [a, UNDEFINED_T] },
    ]),
  );
  expect(unions.shapes("ab")).toMatchObject({ unitTag: -1, nullTag: -1 });
  expect(unions.shapes("abu")).toMatchObject({ unitTag: 1, nullTag: -1 });
  expect(unions.shapes("abnu")).toMatchObject({ unitTag: 3, nullTag: 2 });
  expect(unions.shapes("abnu")?.arms).toEqual([
    { tag: 0, shapeId: "a" },
    { tag: 1, shapeId: "b" },
  ]);
  // A scalar arm keeps the box; one record arm is a single-arm nullable.
  expect(unions.get("af")).toBeNull();
  expect(unions.single("au")).not.toBeNull();
  expect(unions.shapes("au")).toBeNull();
  // Tagged shapes number from 2 and move their fields after the word.
  expect([unions.shapeNumber("a"), unions.shapeNumber("b"), unions.shapeNumber("c")]).toEqual([
    2, 3, 0,
  ]);
  expect([unions.fieldBase("a"), unions.fieldBase("c")]).toEqual([2, 1]);
  expect(unions.boxedUnions(new Map([["af", { id: "af", arms: [a, F64] }]])).size).toBe(1);
});

test("records of runtime-inspected unions keep every union over them boxed", () => {
  const set: IrType = { kind: "set", elem: { kind: "union", unionId: "ab" } };
  const unions = new NullableUnions(
    module(
      [
        { id: "ab", arms: [a, b] },
        { id: "abu", arms: [a, b, UNDEFINED_T] },
        { id: "bc", arms: [b, c] },
        { id: "ac", arms: [a, c] },
      ],
      { globals: [{ id: "%g.s", name: "s", type: set, mutable: false }] },
    ),
  );
  expect(unions.get("ab")).toBeNull();
  expect(unions.get("abu")).toBeNull();
  expect(unions.get("bc")).toBeNull();
  expect(unions.get("ac")).toBeNull();
  expect(unions.shapeNumber("c")).toBe(0);
});

test("library, lifetime-region and debug builds keep record unions boxed", () => {
  const unions = [{ id: "ab", arms: [a, b] }];
  expect(new NullableUnions(module(unions), false).get("ab")).toBeNull();
  expect(new NullableUnions(module(unions, { lifetimeRegions: true })).get("ab")).toBeNull();
  expect(new NullableUnions(module(unions)).shapes("ab")).not.toBeNull();
});

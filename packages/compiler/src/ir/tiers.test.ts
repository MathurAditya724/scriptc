import { expect, test } from "vitest";
import { BOOL, DYN, F64, STRING, VOID, type IrExpr, type IrFunction, type IrModule } from "./ir.js";
import {
  deserializeModule,
  deserializeModuleBytes,
  serializeModule,
  serializeModuleParts,
} from "./serialize.js";
import {
  assignLegacyTiers,
  dynamicOperationOf,
  firstDynamicOperation,
  functionTier,
} from "./tiers.js";
import { validateModule } from "./validate.js";

const loc = { file: "tiers.ts", start: 0, end: 0 };
const dynParam = { kind: "varRef", localId: "v", type: DYN, loc } as const satisfies IrExpr;

function fn(name: string, value: IrExpr): IrFunction {
  return {
    name,
    params: [{ localId: "v", name: "v", type: DYN }],
    returnType: value.type,
    locals: [{ id: "v", name: "v", type: DYN, mutable: false }],
    body: [{ kind: "return", value, loc }],
    loc,
  };
}

function moduleOf(...functions: IrFunction[]): IrModule {
  const main: IrFunction = {
    name: "%main",
    params: [],
    returnType: VOID,
    locals: [],
    body: [],
    loc,
  };
  return { irVersion: 16, sourceFile: "tiers.ts", functions: [main, ...functions], entry: "%main" };
}

const keyGet: IrExpr = {
  kind: "dynKeyGet",
  key: { kind: "strLit", value: "name", type: STRING, loc },
  value: dynParam,
  type: DYN,
  loc,
};

test("dynamic operations and boundary operations are told apart", () => {
  expect(dynamicOperationOf(keyGet)).toBe("dynKeyGet");
  expect(
    dynamicOperationOf({
      kind: "libCall",
      fn: "dyn.add",
      args: [dynParam, dynParam],
      type: DYN,
      loc,
    }),
  ).toBe("dyn.add");
  expect(
    dynamicOperationOf({
      kind: "call",
      callee: "%dyn.class.property.12",
      args: [dynParam],
      type: DYN,
      loc,
    }),
  ).toBe("%dyn.class.property");
  // Boundary operations: conversions and kind tests.
  expect(dynamicOperationOf({ kind: "dynCheck", value: dynParam, type: F64, loc })).toBeNull();
  expect(
    dynamicOperationOf({
      kind: "dynFrom",
      value: { kind: "numLit", value: 1, type: F64, loc },
      type: DYN,
      loc,
    }),
  ).toBeNull();
  expect(
    dynamicOperationOf({ kind: "dynTest", test: "string", value: dynParam, type: BOOL, loc }),
  ).toBeNull();
  expect(
    dynamicOperationOf({ kind: "libCall", fn: "dyn.typedRefIs", args: [dynParam], type: DYN, loc }),
  ).toBeNull();
  // Moves and calls of ordinary functions.
  expect(dynamicOperationOf(dynParam)).toBeNull();
  expect(
    dynamicOperationOf({ kind: "call", callee: "helper", args: [dynParam], type: DYN, loc }),
  ).toBeNull();
});

test("lowering's classification puts exactly the functions with dynamic operations in the dynamic tier", () => {
  const reader = fn("reader", keyGet);
  const mover = fn("mover", dynParam);
  const dynamic = assignLegacyTiers([reader, mover]);
  expect(dynamic.map((d) => [d.name, d.operation])).toEqual([["reader", "dynKeyGet"]]);
  expect(functionTier(reader)).toBe("dynamic");
  expect(functionTier(mover)).toBe("static");
  expect(firstDynamicOperation(mover)).toBeNull();
});

test("the validator enforces I1: static functions perform no dynamic operation", () => {
  const reader = fn("reader", keyGet);
  const errors = validateModule(moduleOf(reader));
  expect(errors.map((e) => e.message)).toEqual([
    "in reader: static-tier function performs the dynamic operation dynKeyGet",
  ]);
  reader.tier = "dynamic";
  expect(validateModule(moduleOf(reader))).toEqual([]);
  // A logical operator over dynamic values applies ToBoolean to them.
  const either = fn("either", {
    kind: "logical",
    op: "||",
    left: dynParam,
    right: dynParam,
    type: DYN,
    loc,
  });
  expect(validateModule(moduleOf(either)).map((e) => e.message)).toEqual([
    "in either: static-tier function performs the dynamic operation logical",
  ]);
});

test("serialized IR carries no tiers in stage S2, and loading derives them again", () => {
  const reader = fn("reader", keyGet);
  const mod = moduleOf(reader);
  const untiered = serializeModule(mod, true);
  assignLegacyTiers(mod.functions);
  expect(reader.tier).toBe("dynamic");
  expect(serializeModule(mod, true)).toBe(untiered);
  expect(serializeModuleParts(mod).join("")).toBe(untiered);
  expect(serializeModule(mod)).not.toContain('"tier"');
  for (const loaded of [
    deserializeModule(untiered),
    deserializeModuleBytes(Buffer.from(untiered)),
  ]) {
    expect(loaded.functions.map(functionTier)).toEqual(["static", "dynamic"]);
    expect(validateModule(loaded)).toEqual([]);
  }
});

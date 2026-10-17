import { countedFor, varRef } from "../../../ir/build.js";
import * as ts from "../../ts7/adapter.js";
import type { Lowerer } from "../lowerer.js";
import {
  BOOL,
  F64,
  type IrExpr,
  type IrFunction,
  type IrLocal,
  type IrStmt,
  type IrType,
  STRING,
  type SrcLoc,
  UNDEFINED_T,
  VOID,
  typeEquals,
} from "../../../ir/ir.js";
import { locOf } from "../../program.js";
import { typeKey } from "../../type-mapper.js";

/** Object.groupBy / Map.groupBy (ES2024): group an ARRAY's elements by a
 * per-element key. Both lower to one interned helper loop per callback
 * type — the callback runs synchronously per element (index included in
 * the two-parameter form), the first occurrence of a key creates its
 * group in encounter order, and later hits push onto the same array
 * (JS's exact accumulation — the stored arrays are the live groups).
 * Map.groupBy keeps typed keys under SameValueZero; Object.groupBy
 * requires a STRING-KEYED result (Partial<Record<string, T[]>> — a
 * literal-union key type makes a fixed-field record, which has no
 * grouping representation) and stringifies number keys like JS property
 * keys. Node's result carries a null prototype — records here have no
 * prototype at all, so the difference is unobservable except through
 * util.inspect's "[Object: null prototype]" prefix (ledgered). Other
 * iterables fence (spread into an array first); Null when the callee
 * isn't the stdlib Object/Map groupBy. */
export function lowerGroupByStaticCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (call.questionDotToken || access.questionDotToken) return null;
  if (access.name.text !== "groupBy") return null;
  const isMap = lowerer.isStdlibGlobal(access.expression, "Map");
  const isObject = !isMap && lowerer.isStdlibGlobal(access.expression, "Object");
  if (!isMap && !isObject) return null;
  if (!lowerer.isStdlibMember(access)) return null;
  const what = isMap ? "Map.groupBy" : "Object.groupBy";
  const loc = locOf(call);
  if (call.arguments.length !== 2 || call.arguments.some((a) => ts.isSpreadElement(a))) {
    lowerer.noLowering(`${what} with ${call.arguments.length} arguments`, call);
  }
  const items = lowerer.lowerExpr(call.arguments[0]!);
  if (items.type.kind !== "array") {
    lowerer.noLowering(
      `${what} over an iterable of type '${lowerer.checker.typeToString(lowerer.typeOf(call.arguments[0]!))}'`,
      call.arguments[0]!,
      "arrays are the supported items form — spread other iterables first: [...items]",
    );
  }
  const elem = items.type.elem;
  const f = lowerer.lowerExpr(call.arguments[1]!);
  if (
    f.type.kind !== "func" ||
    f.type.params.length > 2 ||
    (f.type.params.length >= 1 && !typeEquals(f.type.params[0]!, elem)) ||
    (f.type.params.length === 2 && f.type.params[1]!.kind !== "f64")
  ) {
    lowerer.badType(call.arguments[1]!, lowerer.typeOf(call.arguments[1]!));
  }
  const keyT = f.type.ret;
  // The call's own type keeps the callback's literal-union key type
  // (Partial<Record<"even" | "odd", T[]>> — a FIXED-FIELD record, which
  // has no grouping representation); a CONTEXT naming the string-keyed
  // form (the annotated-const idiom) is the groupable reading, so it
  // wins when it maps that way.
  const ctxT = lowerer.checker.getContextualType(call);
  const ctxMapped = ctxT !== undefined ? lowerer.mapTypeOf(ctxT) : null;
  const ownMapped = lowerer.mapTypeOf(lowerer.typeOf(call));
  if (isMap) {
    const resultT = ctxMapped?.kind === "map" ? ctxMapped : ownMapped;
    if (
      resultT?.kind !== "map" ||
      !typeEquals(resultT.key, keyT) ||
      !typeEquals(resultT.value, items.type)
    ) {
      lowerer.noLowering(
        `${what} at this result type`,
        call,
        "the result must be Map<K, T[]> over the callback's K and the items' T — annotate: Map.groupBy<K, T>(items, f)",
      );
    }
    const key = `map.groupBy:${typeKey(f.type)}`;
    let helper = lowerer.mapHofHelpers.get(key);
    if (!helper) {
      helper = `%map.groupBy.${lowerer.mapHofHelpers.size}`;
      lowerer.mapHofHelpers.set(key, helper);
      lowerer.liftedFns.push(buildGroupByFn(lowerer, helper, items.type, f.type, resultT, loc));
    }
    return { kind: "call", callee: helper, args: [items, f], type: resultT, loc };
  }
  // A groupable reading is an INDEX-SIGNATURE record (no declared
  // fields). Either candidate qualifying proves the checker committed
  // the result to the string-keyed form; the VALUE's shape is then
  // minted exactly (fields none, index value T[] | undefined — the
  // structural intern, so a matching annotation shares the id) rather
  // than adopted, because mapped-type instantiations can arrive with a
  // widened index value.
  const indexShaped = (t: IrType | null): boolean => {
    if (t?.kind !== "record") return false;
    const s = lowerer.shapes.get(t.shapeId);
    return s !== undefined && s.fields.length === 0 && s.indexValue !== undefined;
  };
  if (
    (!indexShaped(ctxMapped) && !indexShaped(ownMapped)) ||
    (keyT.kind !== "string" && keyT.kind !== "f64")
  ) {
    lowerer.noLowering(
      `${what} at this result type`,
      call,
      "a string-keyed result (Partial<Record<string, T[]>>) is the supported form — a literal-union " +
        "key type makes a fixed-field record: widen the callback's key type to string " +
        "(numbers stringify like JS property keys)",
    );
  }
  const resultT: IrType & { kind: "record" } = {
    kind: "record",
    shapeId: lowerer.shapes.intern([], false, lowerer.withUndefinedArm(items.type), []),
  };
  const key = `object.groupBy:${typeKey(f.type)}`;
  let helper = lowerer.mapHofHelpers.get(key);
  if (!helper) {
    helper = `%object.groupBy.${lowerer.mapHofHelpers.size}`;
    lowerer.mapHofHelpers.set(key, helper);
    lowerer.liftedFns.push(buildGroupByFn(lowerer, helper, items.type, f.type, resultT, loc));
  }
  return { kind: "call", callee: helper, args: [items, f], type: resultT, loc };
}

/** The groupBy helper body — one loop, two grouping stores:
 *
 *   g = new Map() | {}
 *   for (i = 0; i < items.length; i++) {
 *     v = items[i]; k = f(v[, i]);
 *     cur = g.get(k)                    // the V|undefined union read
 *     if (cur is undefined) g.set(k, [v]); else cur.push(v);
 *   }
 *   return g
 *
 * The map read/write are mapIntrinsic get/set; the record pair are the
 * overflow keyed get/set with an f64 key stringified first (JS property
 * keys). Both reads answer the value-or-undefined union, so the arm
 * test IS the has() check with one lookup. */
function buildGroupByFn(
  lowerer: Lowerer,
  name: string,
  itemsT: IrType & { kind: "array" },
  fnT: IrType & { kind: "func" },
  resultT: (IrType & { kind: "map" }) | (IrType & { kind: "record" }),
  loc: SrcLoc,
): IrFunction {
  const elem = itemsT.elem;
  const keyT = fnT.ret;
  const arity = fnT.params.length;
  const isMap = resultT.kind === "map";
  // The union the group read answers: the map value's undefined-armed
  // union, or the record shape's index value (validated by the caller).
  const iv: IrType & { kind: "union" } = isMap
    ? (lowerer.withUndefinedArm(itemsT) as IrType & { kind: "union" })
    : (lowerer.shapes.get(resultT.shapeId)!.indexValue as IrType & { kind: "union" });
  const arrTag = lowerer.armTag(iv.unionId, itemsT);
  const undefTag = lowerer.armTag(iv.unionId, UNDEFINED_T);

  const gRef = (): IrExpr => varRef("g.0", resultT, loc);
  const kRef = (): IrExpr => varRef("k.0", keyT, loc);
  // Record keys are property keys: an f64 key stringifies (JS's exact
  // number ToString); map keys stay typed.
  const storeKey = (): IrExpr =>
    isMap || keyT.kind === "string"
      ? kRef()
      : { kind: "toString", operand: kRef(), type: STRING, loc };
  const groupRead = (): IrExpr =>
    isMap
      ? { kind: "mapIntrinsic", method: "get", receiver: gRef(), args: [storeKey()], type: iv, loc }
      : {
          kind: "recordKeyGet",
          obj: gRef(),
          shapeId: (resultT as IrType & { kind: "record" }).shapeId,
          key: storeKey(),
          overflowOnly: true,
          type: iv,
          loc,
        };
  const freshGroup = (): IrExpr => ({
    kind: "arrayLit",
    elems: [varRef("v.0", elem, loc)],
    type: itemsT,
    loc,
  });
  const groupWrite = (): IrStmt =>
    isMap
      ? {
          kind: "exprStmt",
          expr: {
            kind: "mapIntrinsic",
            method: "set",
            receiver: gRef(),
            args: [storeKey(), freshGroup()],
            type: VOID,
            loc,
          },
          loc,
        }
      : {
          kind: "recordKeySet",
          obj: gRef(),
          shapeId: (resultT as IrType & { kind: "record" }).shapeId,
          key: storeKey(),
          value: {
            kind: "unionWrap",
            unionId: iv.unionId,
            tag: arrTag,
            value: freshGroup(),
            type: iv,
            loc,
          },
          loc,
        };
  const callArgs: IrExpr[] = [];
  if (arity >= 1) callArgs.push(varRef("v.0", elem, loc));
  if (arity === 2) callArgs.push(varRef("i.0", F64, loc));
  const locals: IrLocal[] = [
    { id: "items.0", name: "items", type: itemsT, mutable: true },
    { id: "f.0", name: "f", type: fnT, mutable: true },
    { id: "g.0", name: "g", type: resultT, mutable: false },
    { id: "n.0", name: "n", type: F64, mutable: false },
    { id: "i.0", name: "i", type: F64, mutable: true },
    { id: "v.0", name: "v", type: elem, mutable: false },
    { id: "k.0", name: "k", type: keyT, mutable: false },
    { id: "cur.0", name: "cur", type: iv, mutable: false },
  ];
  const body: IrStmt[] = [
    {
      kind: "varDecl",
      localId: "g.0",
      // Object.groupBy's result object has a null prototype.
      init: isMap
        ? { kind: "mapNew", type: resultT, loc }
        : { kind: "recordLit", fields: [], nullProto: true, type: resultT, loc },
      loc,
    },
    {
      kind: "varDecl",
      localId: "n.0",
      init: {
        kind: "arrIntrinsic",
        method: "length",
        receiver: varRef("items.0", itemsT, loc),
        args: [],
        type: F64,
        loc,
      },
      loc,
    },
    countedFor(loc, varRef("n.0", F64, loc), () => [
      {
        kind: "varDecl",
        localId: "v.0",
        init: {
          kind: "arrayGet",
          arr: varRef("items.0", itemsT, loc),
          index: varRef("i.0", F64, loc),
          type: elem,
          loc,
        },
        loc,
      },
      {
        kind: "varDecl",
        localId: "k.0",
        init: {
          kind: "callValue",
          callee: varRef("f.0", fnT, loc),
          args: callArgs,
          type: keyT,
          loc,
        },
        loc,
      },
      { kind: "varDecl", localId: "cur.0", init: groupRead(), loc },
      {
        kind: "if",
        cond: {
          kind: "unionIsTag",
          unionId: iv.unionId,
          tag: undefTag,
          negated: false,
          value: varRef("cur.0", iv, loc),
          type: BOOL,
          loc,
        },
        then: [groupWrite()],
        else_: [
          {
            kind: "exprStmt",
            expr: {
              kind: "arrIntrinsic",
              method: "push",
              receiver: {
                kind: "unionNarrow",
                unionId: iv.unionId,
                tag: arrTag,
                value: varRef("cur.0", iv, loc),
                type: itemsT,
                loc,
              },
              args: [varRef("v.0", elem, loc)],
              type: F64,
              loc,
            },
            loc,
          },
        ],
        loc,
      },
    ]),
    { kind: "return", value: gRef(), loc },
  ];
  return {
    name,
    params: [
      { localId: "items.0", name: "items", type: itemsT },
      { localId: "f.0", name: "f", type: fnT },
    ],
    returnType: resultT,
    locals,
    body,
    loc,
  };
}

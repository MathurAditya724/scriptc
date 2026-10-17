import { boolLit, numLit, varRef } from "../../../ir/build.js";
import * as ts from "../../ts7/adapter.js";
import type { Lowerer } from "../lowerer.js";
import {
  BOOL,
  CAUGHT,
  F64,
  VOID,
  type IrExpr,
  type IrParam,
  type IrStmt,
  type IrType,
  type SrcLoc,
  typeEquals,
} from "../../../ir/ir.js";
import { locOf } from "../../program.js";
import { arrayValueRead, arrayValueStore, arrayValueType } from "../array-values.js";
import { newFnCtx } from "../function-context.js";
import { lowerArrayCallback } from "./callback-arguments.js";

/** `Array.fromAsync(source, mapFn?)` over an array, as an async helper
 * with the spec's loop:
 *
 *   const out = []; let k = 0;
 *   for await (const v of source) out.push(mapFn ? await mapFn(v, k++) : v);
 *   return out;
 *
 * An array iterates through the async-from-sync iterator: each element is
 * awaited (a promise element through its promise, any other value as one
 * resolved promise), and the iterator result is awaited again, which the
 * helper spells as the same microtask hops the `for await` array loop
 * takes. A throwing or rejecting mapFn, and a rejected element, close the
 * iterator before the returned promise rejects. Null when this is not an
 * `Array.fromAsync` call. */
export function lowerArrayFromAsyncCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (call.questionDotToken || access.questionDotToken) return null;
  if (!lowerer.isStdlibGlobal(access.expression, "Array")) return null;
  if (access.name.text !== "fromAsync") return null;
  const loc = locOf(call);
  const args = call.arguments;
  if (args.length < 1 || args.length > 2 || args.some(ts.isSpreadElement)) {
    lowerer.noLowering(
      `Array.fromAsync with ${args.length} arguments`,
      call,
      "pass the source and an optional mapping function",
    );
  }
  const resultT = lowerer.mapTypeOf(lowerer.typeOf(call));
  if (resultT?.kind !== "promise" || resultT.inner.kind !== "array")
    lowerer.badType(call, lowerer.typeOf(call));
  const outT = resultT.inner;
  const source = lowerer.lowerExpr(args[0]!);
  if (source.type.kind !== "array") {
    if (source.type.kind === "generator" && source.type.async) {
      // An async generator's completion settles one microtask later here
      // than in Node, which would reorder the returned promise.
      lowerer.noLowering(
        "Array.fromAsync over an async generator",
        args[0]!,
        "collect its values with for await",
      );
    }
    lowerer.noLowering(
      `Array.fromAsync over a value of type '${lowerer.checker.typeToString(lowerer.typeOf(args[0]!))}'`,
      args[0]!,
      "an array is the supported source",
    );
  }
  const step = arraySourceStep(lowerer, args[0]!, source.type.elem);
  let mapper: (IrExpr & { type: IrType & { kind: "func" } }) | null = null;
  if (args[1]) {
    const callback = lowerArrayCallback(lowerer, args[1], [step.valueT], outT);
    if (callback.arity > 2)
      lowerer.noLowering("an Array.fromAsync mapping function with three parameters", args[1]);
    mapper = callback.fnArg;
    const ret = mapper.type.ret;
    if (ret.kind !== "promise" && !nonThenable(lowerer, ret)) {
      lowerer.noLowering(
        "an Array.fromAsync mapping function whose result may be a promise or thenable",
        args[1],
        "return a value or a Promise",
      );
    }
  }
  const name = `%array.fromAsync.${lowerer.liftedFns.length}`;
  const context = newFnCtx(false, null, null, outT);
  context.isAsync = true;
  lowerer.fnStack.push(context);
  try {
    const src = lowerer.declareHiddenLocal("source", source.type);
    const params: IrParam[] = [{ localId: src.id, name: "source", type: source.type }];
    let mapperRef: (IrExpr & { type: IrType & { kind: "func" } }) | null = null;
    if (mapper) {
      const local = lowerer.declareHiddenLocal("mapFn", mapper.type);
      params.push({ localId: local.id, name: "mapFn", type: mapper.type });
      mapperRef = { kind: "varRef", localId: local.id, type: mapper.type, loc };
    }
    const out = lowerer.declareHiddenLocal("%fromAsyncOut", outT);
    const k = lowerer.declareHiddenLocal("%fromAsyncIndex", F64);
    k.mutable = true;
    const kRef = varRef(k.id, F64, loc);
    const append = (value: IrExpr): IrStmt[] => {
      const stmts: IrStmt[] = [];
      let item = value;
      if (mapperRef) {
        const mapped: IrExpr = {
          kind: "callValue",
          callee: mapperRef,
          args: [value, kRef].slice(0, mapperRef.type.params.length),
          type: mapperRef.type.ret,
          loc,
        };
        if (mapped.type.kind === "promise") {
          item = { kind: "awaitExpr", value: mapped, type: mapped.type.inner, loc };
        } else {
          // Await of a value that is not a thenable: one resolved promise.
          const held = lowerer.declareHiddenLocal("%fromAsyncMapped", mapped.type);
          stmts.push({ kind: "varDecl", localId: held.id, init: mapped, loc }, hop(loc));
          item = varRef(held.id, held.type, loc);
        }
      }
      stmts.push(
        arrayValueStore(
          lowerer,
          varRef(out.id, outT, loc),
          kRef,
          // arrayValueStore stores an undefined arm (a hole) as undefined.
          typeEquals(item.type, outT.elem) || item.type.kind === "union"
            ? item
            : lowerer.coerceToExpected(item, outT.elem),
          outT.elem,
          loc,
        ),
        {
          kind: "assign",
          localId: k.id,
          value: { kind: "bin", op: "+", left: kRef, right: numLit(1, loc), type: F64, loc },
          loc,
        },
      );
      return stmts;
    };
    const body: IrStmt[] = [
      {
        kind: "varDecl",
        localId: out.id,
        init: { kind: "arrayLit", elems: [], type: outT, loc },
        loc,
      },
      { kind: "varDecl", localId: k.id, init: numLit(0, loc), loc },
      ...step.loop(varRef(src.id, source.type, loc), append, loc),
      { kind: "return", value: varRef(out.id, outT, loc), loc },
    ];
    lowerer.liftedFns.push({
      name,
      params,
      returnType: outT,
      locals: context.locals,
      body,
      async: true,
      loc,
    });
  } finally {
    lowerer.fnStack.pop();
  }
  return {
    kind: "call",
    callee: name,
    args: mapper ? [source, mapper] : [source],
    type: resultT,
    loc,
  };
}

function hop(loc: SrcLoc): IrStmt {
  return {
    kind: "exprStmt",
    expr: { kind: "libCall", fn: "async.hop", args: [], type: VOID, loc },
    loc,
  };
}

/** A value whose await takes one microtask without calling user code:
 * primitives, arrays and records without a `then` field. */
function nonThenable(lowerer: Lowerer, type: IrType): boolean {
  if (type.kind === "union") {
    const arms = lowerer.unions.get(type.unionId)?.arms;
    return arms !== undefined && arms.every((arm) => nonThenable(lowerer, arm));
  }
  if (type.kind === "record") {
    const shape = lowerer.shapes.get(type.shapeId);
    return shape !== undefined && !shape.indexValue && !shape.fields.some((f) => f.name === "then");
  }
  return (
    type.kind === "f64" ||
    type.kind === "bigint" ||
    type.kind === "string" ||
    type.kind === "bool" ||
    type.kind === "symbol" ||
    type.kind === "array" ||
    type.kind === "undefinedT" ||
    type.kind === "nullT"
  );
}

/** The `for await` array loop (lowerForOf's async-from-sync form): two
 * hops per element that is not a promise, the element's own await plus
 * one hop for a promise element, two hops before the final done result,
 * and one hop to close the iterator when the body completes abruptly. */
function arraySourceStep(
  lowerer: Lowerer,
  node: ts.Expression,
  elem: IrType,
): {
  /** The awaited value each element hands to the mapping function. */
  valueT: IrType;
  loop(source: IrExpr, append: (value: IrExpr) => IrStmt[], loc: SrcLoc): IrStmt[];
} {
  const yieldedT = arrayValueType(lowerer, elem);
  let promiseTag: number | null = null;
  let valueT = yieldedT;
  const promiseElem = elem.kind === "promise" ? elem : null;
  if (
    promiseElem &&
    yieldedT.kind === "union" &&
    !["void", "union", "dyn", "undefinedT", "nullT"].includes(promiseElem.inner.kind)
  ) {
    promiseTag = lowerer.armTag(yieldedT.unionId, promiseElem);
    valueT = lowerer.withUndefinedArm(promiseElem.inner);
  } else if (!nonThenable(lowerer, elem)) {
    lowerer.noLowering(
      "Array.fromAsync over array values that may be promises or thenables",
      node,
      "use an array of values or an array of promises",
    );
  }
  return {
    valueT,
    loop(source, append, loc) {
      const arr = lowerer.declareHiddenLocal("%fromAsyncArray", source.type);
      const cursor = lowerer.declareHiddenLocal("%fromAsyncCursor", F64);
      cursor.mutable = true;
      const needsClose = lowerer.declareHiddenLocal("%fromAsyncNeedsClose", BOOL);
      needsClose.mutable = true;
      const value = lowerer.declareHiddenLocal("%fromAsyncValue", valueT);
      value.mutable = true;
      const arrRef = varRef(arr.id, source.type, loc);
      const cursorRef = varRef(cursor.id, F64, loc);
      const read = arrayValueRead(lowerer, arrRef, cursorRef, elem, loc);
      const setClose = (on: boolean): IrStmt => ({
        kind: "assign",
        localId: needsClose.id,
        value: boolLit(on, loc),
        loc,
      });
      // A rejected element rejects the next result one reaction later, and
      // Node closes the iterator before the returned promise rejects.
      const awaitInto = (awaited: IrExpr): IrStmt => {
        const error = lowerer.declareHiddenLocal("%fromAsyncNextError", CAUGHT);
        return {
          kind: "tryCatch",
          tryBody: [{ kind: "assign", localId: value.id, value: awaited, loc }],
          catchBody: [hop(loc), hop(loc), { kind: "rethrow", localId: error.id, loc }],
          catchLocalId: error.id,
          finallyBody: null,
          loc,
        };
      };
      const next: IrStmt[] = [];
      if (promiseTag !== null) {
        next.push(
          awaitInto({ kind: "awaitUnionExpr", value: read, promiseTag, type: valueT, loc }),
          hop(loc),
        );
      } else {
        next.push({ kind: "assign", localId: value.id, value: read, loc }, hop(loc), hop(loc));
      }
      const length: IrExpr = {
        kind: "arrIntrinsic",
        method: "length",
        receiver: arrRef,
        args: [],
        type: F64,
        loc,
      };
      const loop: IrStmt = {
        kind: "for",
        init: { kind: "varDecl", localId: cursor.id, init: numLit(0, loc), loc },
        cond: boolLit(true, loc),
        update: {
          kind: "assign",
          localId: cursor.id,
          value: { kind: "bin", op: "+", left: cursorRef, right: numLit(1, loc), type: F64, loc },
          loc,
        },
        body: [
          setClose(false),
          {
            kind: "if",
            cond: { kind: "bin", op: ">=", left: cursorRef, right: length, type: BOOL, loc },
            then: [hop(loc), hop(loc), { kind: "break", loc }],
            else_: null,
            loc,
          },
          ...next,
          setClose(true),
          ...append(varRef(value.id, valueT, loc)),
        ],
        loc,
      };
      return [
        { kind: "varDecl", localId: arr.id, init: source, loc },
        { kind: "varDecl", localId: needsClose.id, init: boolLit(false, loc), loc },
        { kind: "varDecl", localId: value.id, init: null, loc },
        {
          kind: "tryCatch",
          tryBody: [loop],
          catchBody: null,
          catchLocalId: null,
          finallyBody: [
            {
              kind: "if",
              cond: varRef(needsClose.id, BOOL, loc),
              then: [hop(loc)],
              else_: null,
              loc,
            },
          ],
          loc,
        },
      ];
    },
  };
}

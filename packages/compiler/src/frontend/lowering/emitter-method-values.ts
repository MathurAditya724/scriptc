/**
 * EventEmitter.prototype's methods as values. A read of `o.on` on a
 * compiled emitter (a program class extending EventEmitter, or
 * `new EventEmitter()`) through an untyped value or as a value, and
 * `EventEmitter.prototype.on` itself, answer the runtime's
 * EventEmitter.prototype functions (scr_dyn_builtin_class.c), the same
 * functions JavaScript constructor functions inherit: `on` and
 * `addListener` are one function, as are `off` and `removeListener`, and
 * each carries Node's `name` and `length`. Called on a compiled emitter
 * (`f.call(o, …)`, `f.bind(o)`, `f.apply(o, …)`), such a function hands
 * the call to the program's dispatch below, which invokes the method on
 * the receiver through the same untyped dispatch a direct `o.on(…)` call
 * reaches.
 */
import { BOOL, DYN, F64, STRING, type IrExpr, type IrStmt, type SrcLoc } from "../../ir/ir.js";
import { dynUndefinedExpr, strLit, varRef } from "../../ir/build.js";
import * as ts from "../ts7/adapter.js";
import { locOf } from "../program.js";
import type { Lowerer } from "./lowerer.js";
import { findGenericMethodOn, findMethodOn, type ClassInfo } from "./lower-classes.js";

/** EventEmitter.prototype's method names. */
export const EMITTER_PROTOTYPE_METHODS: ReadonlySet<string> = new Set([
  "setMaxListeners",
  "getMaxListeners",
  "emit",
  "addListener",
  "on",
  "prependListener",
  "once",
  "prependOnceListener",
  "removeListener",
  "off",
  "removeAllListeners",
  "listeners",
  "rawListeners",
  "listenerCount",
  "eventNames",
]);

/** `emit` forwards this many arguments after the event name; a call with
 * more fences. */
const EMIT_ARGUMENTS = 4;

/** The runtime's SCR_EE_M_* order: each method's name and the argument
 * counts its call forwards. Node's methods that look at
 * `arguments.length` (removeAllListeners, emit, listenerCount's optional
 * listener) get exactly the arguments given; the rest get their declared
 * parameters, an absent one as undefined. */
const DISPATCHED: readonly {
  method: string;
  fixed?: number;
  counts?: (given: number) => number;
}[] = [
  { method: "addListener", fixed: 2 },
  { method: "prependListener", fixed: 2 },
  { method: "once", fixed: 2 },
  { method: "prependOnceListener", fixed: 2 },
  { method: "removeListener", fixed: 2 },
  { method: "removeAllListeners", counts: (given) => Math.min(given, 1) },
  { method: "emit", counts: (given) => Math.max(given, 1) },
  { method: "listeners", fixed: 1 },
  { method: "rawListeners", fixed: 1 },
  { method: "listenerCount", counts: (given) => (given < 2 ? 1 : 2) },
  { method: "eventNames", fixed: 0 },
  { method: "setMaxListeners", fixed: 1 },
  { method: "getMaxListeners", fixed: 0 },
];

const DISPATCH = "%emitter.method.dispatch";

/** An EventEmitter.prototype method a non-stream emitter class inherits
 * (no field, method or accessor of that name in its chain; streams keep
 * their own surface). An `emit` override is not a method, so `emit` counts
 * here too; overriddenEmit separates it. */
export function inheritedEmitterMethod(lowerer: Lowerer, info: ClassInfo, name: string): boolean {
  if (!EMITTER_PROTOTYPE_METHODS.has(name)) return false;
  let emitter = false;
  for (let c: ClassInfo | null = info; c; c = c.base) {
    if (c.builtinStream !== undefined) return false;
    if (c.builtinEmitter) emitter = true;
  }
  return (
    emitter &&
    !info.fields.has(name) &&
    !findMethodOn(lowerer, info, name) &&
    !findGenericMethodOn(lowerer, info, name) &&
    !findMethodOn(lowerer, info, `get:${name}`) &&
    !findMethodOn(lowerer, info, `set:${name}`)
  );
}

/** True when the class or an ancestor overrides `emit` (lowered as
 * per-event specializations rather than a method). */
export function overriddenEmit(info: ClassInfo): boolean {
  for (let c: ClassInfo | null = info; c; c = c.base) if (c.emitOverride) return true;
  return false;
}

/** A typed read of an inherited EventEmitter.prototype method as a value
 * (`const f = emitter.on`, `typeof emitter.emit`) on a compiled emitter or
 * a union of them: the receiver is evaluated, the read answers the
 * interned method value. */
export function lowerEmitterInstanceMethod(
  lowerer: Lowerer,
  expr: ts.PropertyAccessExpression,
): IrExpr | null {
  const name = expr.name.text;
  if (!EMITTER_PROTOTYPE_METHODS.has(name) || expr.questionDotToken) return null;
  if (ts.isCallExpression(expr.parent) && expr.parent.expression === expr) return null;
  const symbol = lowerer.checker.getSymbolAtLocation(expr.name);
  if (!symbol || !lowerer.isStdlibSymbol(symbol)) return null;
  const receiverType = lowerer.mapTypeOf(lowerer.typeOf(expr.expression));
  if (!receiverType) return null;
  const arms =
    receiverType.kind === "union"
      ? (lowerer.unions.get(receiverType.unionId)?.arms ?? [])
      : [receiverType];
  if (
    !arms.length ||
    !arms.every((arm) => {
      const info = arm.kind === "object" ? lowerer.classes.get(arm.className) : undefined;
      return info !== undefined && inheritedEmitterMethod(lowerer, info, name);
    })
  )
    return null;
  const loc = locOf(expr);
  return {
    kind: "seqExpr",
    stmts: [{ kind: "exprStmt", expr: lowerer.lowerExpr(expr.expression), loc }],
    result: emitterMethodValue(lowerer, name, loc),
    type: DYN,
    loc,
  };
}

/** The program's dispatch for EventEmitter.prototype's functions on
 * compiled emitters: `this` is the emitter, the first argument the
 * method's index, the rest the call's arguments. */
function emitterMethodDispatch(lowerer: Lowerer, loc: SrcLoc): IrExpr {
  if (!lowerer.liftedFns.some((fn) => fn.name === DISPATCH)) {
    const self = varRef("self", DYN, loc);
    const values = varRef("values", DYN, loc);
    const index = varRef("index", F64, loc);
    const given = varRef("given", F64, loc);
    const number = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });
    const equals = (left: IrExpr, value: number): IrExpr => ({
      kind: "bin",
      op: "===",
      left,
      right: number(value),
      type: BOOL,
      loc,
    });
    const element = (i: number): IrExpr => ({
      kind: "dynKeyGet",
      value: values,
      key: lowerer.coerceToExpected(number(i), DYN),
      type: DYN,
      loc,
    });
    const invoke = (method: string, n: number): IrStmt => ({
      kind: "return",
      value: {
        kind: "dynInvoke",
        recv: self,
        method,
        calleeName: method,
        args: Array.from({ length: n }, (_, i) => element(i + 1)),
        type: DYN,
        loc,
      },
      loc,
    });
    const body: IrStmt[] = [
      {
        kind: "varDecl",
        localId: "self",
        init: { kind: "libCall", fn: "dyn.this", args: [], type: DYN, loc },
        loc,
      },
      {
        kind: "varDecl",
        localId: "index",
        init: { kind: "dynCheck", value: element(0), type: F64, loc },
        loc,
      },
      {
        kind: "varDecl",
        localId: "given",
        init: {
          kind: "bin",
          op: "-",
          left: {
            kind: "dynCheck",
            value: { kind: "dynKeyGet", value: values, key: strLit("length", loc), type: DYN, loc },
            type: F64,
            loc,
          },
          right: number(1),
          type: F64,
          loc,
        },
        loc,
      },
    ];
    DISPATCHED.forEach(({ method, fixed, counts }, i) => {
      const arms: IrStmt[] = [];
      if (fixed !== undefined || !counts) arms.push(invoke(method, fixed ?? 0));
      else {
        // One arm per argument count up to the last one that matters.
        const limit = method === "emit" ? EMIT_ARGUMENTS + 1 : 2;
        for (let n = 0; n < limit; n++)
          arms.push({
            kind: "if",
            cond: equals(given, n),
            then: [invoke(method, counts(n))],
            else_: null,
            loc,
          });
        if (method === "emit")
          arms.push(
            {
              kind: "if",
              cond: equals(given, limit),
              then: [invoke(method, limit)],
              else_: null,
              loc,
            },
            {
              kind: "runtimeFence",
              code: "SC2020",
              message: `calling EventEmitter.prototype.emit through a method value with more than ${EMIT_ARGUMENTS} arguments after the event name is not supported yet`,
              loc,
            },
          );
        else arms.push(invoke(method, counts(limit)));
      }
      body.push({ kind: "if", cond: equals(index, i), then: arms, else_: null, loc });
    });
    body.push({ kind: "return", value: dynUndefinedExpr(loc), loc });
    lowerer.liftedFns.push({
      name: DISPATCH,
      params: [{ localId: "values", name: "values", type: DYN }],
      returnType: DYN,
      locals: [
        { id: "values", name: "values", type: DYN, mutable: false },
        { id: "self", name: "self", type: DYN, mutable: false },
        { id: "index", name: "index", type: F64, mutable: false },
        { id: "given", name: "given", type: F64, mutable: false },
      ],
      body,
      loc,
    });
  }
  return {
    kind: "dynFrom",
    value: {
      kind: "closure",
      fnName: DISPATCH,
      captures: [],
      type: { kind: "func", params: [], ret: DYN, rest: true, argumentsAll: true },
      loc,
    },
    type: DYN,
    loc,
  };
}

/** EventEmitter.prototype[name] (DYN). */
export function emitterMethodValue(lowerer: Lowerer, name: string, loc: SrcLoc): IrExpr {
  return {
    kind: "libCall",
    fn: "dyn.emitterMethod",
    args: [{ kind: "strLit", value: name, type: STRING, loc }, emitterMethodDispatch(lowerer, loc)],
    type: DYN,
    loc,
  };
}

/** `EventEmitter.prototype.<method>` (any import spelling of the class):
 * the interned method value. */
export function lowerEmitterPrototypeMethod(
  lowerer: Lowerer,
  expr: ts.PropertyAccessExpression,
): IrExpr | null {
  if (!EMITTER_PROTOTYPE_METHODS.has(expr.name.text)) return null;
  const prototype = expr.expression;
  if (
    !ts.isPropertyAccessExpression(prototype) ||
    prototype.questionDotToken ||
    prototype.name.text !== "prototype"
  )
    return null;
  const owner = prototype.expression;
  const symbol = ts.isIdentifier(owner)
    ? lowerer.resolveValueSymbol(owner)
    : ts.isPropertyAccessExpression(owner)
      ? lowerer.checker.getSymbolAtLocation(owner.name)
      : null;
  if (!lowerer.builtinEmitterInfoOf(symbol)) return null;
  return emitterMethodValue(lowerer, expr.name.text, locOf(expr));
}

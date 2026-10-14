import * as ts from "../../ts7/adapter.js";
import { type Lowerer } from "../lowerer.js";
import { locOf } from "../../program.js";
import { numLit, varRef } from "../../../ir/build.js";
import {
  BOOL,
  DYN,
  F64,
  type IrExpr,
  type IrLibFn,
  type IrStmt,
  type IrType,
  STRING,
  type SrcLoc,
  VOID,
  funcOf,
  typeKey,
} from "../../../ir/ir.js";
import { PERF_ENTRY_FIELDS, PERF_ENTRY_MARKER, perfEntryJsonShape } from "../../type-mapper.js";
import { builtinImportOf } from "./module-bindings.js";
import { checkedIterableSpread } from "../checked-iterable-spread.js";

/** True for any spelling of node:perf_hooks' `performance` object — the
 * named import binding, a namespace/default-import member, the require
 * twins (all through the shared builtin tables), or the GLOBAL Node
 * exposes without any import (the module export and the global are one
 * value; provenance-checked like console/process, so the bare
 * identifier and the globalThis.performance member both land here and
 * a user's own `performance` binding never does). */
function isPerfHooksPerformanceExpr(lowerer: Lowerer, node: ts.Expression): boolean {
  if (lowerer.isStdlibGlobal(node, "performance")) return true;
  if (ts.isIdentifier(node)) {
    const bi = builtinImportOf(lowerer, node);
    return bi !== null && bi.module === "perf_hooks" && bi.member === "performance";
  }
  if (ts.isPropertyAccessExpression(node) && !node.questionDotToken) {
    const bi = lowerer.builtinMemberOf(node);
    return bi !== null && bi.module === "perf_hooks" && bi.member === "performance";
  }
  return false;
}

/** The user-timing members of the performance object: the runtime entry
 * point and, for the getters, the getEntries selector. */
const PERF_TIMELINE_CALLS: ReadonlyMap<string, { fn: IrLibFn; which?: number }> = new Map([
  ["mark", { fn: "perf.mark" }],
  ["measure", { fn: "perf.measure" }],
  ["getEntries", { fn: "perf.entries", which: 0 }],
  ["getEntriesByName", { fn: "perf.entries", which: 1 }],
  ["getEntriesByType", { fn: "perf.entries", which: 2 }],
  ["clearMarks", { fn: "perf.clearMarks" }],
  ["clearMeasures", { fn: "perf.clearMeasures" }],
]);

/** Presence probes do not extract an unbound Performance method value. */
export function lowerPerfHooksTypeof(lowerer: Lowerer, expression: ts.Expression): IrExpr | null {
  const value = isPerfHooksPerformanceExpr(lowerer, expression)
    ? "object"
    : ts.isPropertyAccessExpression(expression) &&
        !expression.questionDotToken &&
        (expression.name.text === "now" || PERF_TIMELINE_CALLS.has(expression.name.text)) &&
        isPerfHooksPerformanceExpr(lowerer, expression.expression)
      ? "function"
      : null;
  return value === null ? null : { kind: "strLit", value, type: STRING, loc: locOf(expression) };
}

/** The node:perf_hooks spoke: `performance.now()` reads the runtime's
 * monotonic clock anchored at process start — Node's timeOrigin for a
 * compiled program, fractional milliseconds — and
 * `performance.now.bind(performance)` (the mockable-clock idiom's
 * getTimestamp) is the same clock as a plain () => number function
 * value. mark/measure, the getEntries family and the clears run over the
 * runtime's performance timeline (lowerPerfTimelineCall), and an entry's
 * toJSON() answers its plain object. Other members on the performance
 * object fence by name; null for non-perf_hooks callees (the call chain
 * keeps trying). */
export function lowerPerfHooksCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (access.questionDotToken) return null;
  const loc = locOf(expr);
  if (access.name.text === "now" && isPerfHooksPerformanceExpr(lowerer, access.expression)) {
    if (expr.arguments.length !== 0) {
      lowerer.noLowering(
        "performance.now with arguments",
        expr,
        "Node's performance.now takes none",
      );
    }
    return { kind: "libCall", fn: "perf.now", args: [], type: F64, loc };
  }
  if (
    access.name.text === "bind" &&
    ts.isPropertyAccessExpression(access.expression) &&
    !access.expression.questionDotToken &&
    access.expression.name.text === "now" &&
    isPerfHooksPerformanceExpr(lowerer, access.expression.expression)
  ) {
    if (expr.arguments.length !== 1 || !isPerfHooksPerformanceExpr(lowerer, expr.arguments[0]!)) {
      lowerer.noLowering(
        "this performance.now.bind form",
        expr,
        "performance.now.bind(performance) is the lowered function-value spelling",
      );
    }
    return {
      kind: "closure",
      fnName: perfNowFnValueOf(lowerer),
      captures: [],
      type: funcOf([], F64),
      loc,
    };
  }
  if (
    access.name.text === "toJSON" &&
    isPerfEntryType(lowerer, lowerer.mapTypeOf(lowerer.typeOf(access.expression)))
  ) {
    if (expr.arguments.length !== 0) {
      lowerer.noLowering("PerformanceEntry toJSON with arguments", expr);
    }
    const entry = lowerer.lowerExpr(access.expression);
    if (entry.type.kind !== "record")
      lowerer.badType(access.expression, lowerer.typeOf(access.expression));
    return {
      kind: "dynFrom",
      value: perfEntryJson(lowerer, entry, entry.type, loc),
      type: DYN,
      loc,
    };
  }
  const timeline = PERF_TIMELINE_CALLS.get(access.name.text);
  if (timeline && isPerfHooksPerformanceExpr(lowerer, access.expression)) {
    return lowerPerfTimelineCall(lowerer, expr, access.name.text, timeline, loc);
  }
  if (isPerfHooksPerformanceExpr(lowerer, access.expression)) {
    lowerer.noLowering(
      `perf_hooks performance.${access.name.text}`,
      expr,
      "performance.now() (and its .bind(performance) function value), mark, measure, the getEntries family, clearMarks and clearMeasures are the lowered surface",
    );
  }
  return null;
}

/** The memoized () => number lifted wrapper behind
 * performance.now.bind(performance): a plain function value over the
 * same perf.now libCall. */
function perfNowFnValueOf(lowerer: Lowerer): string {
  const name = "%perf.now.value";
  if (!lowerer.liftedFns.some((f) => f.name === name)) {
    const loc: SrcLoc = { file: "<builtin>", start: 0, end: 0 };
    lowerer.liftedFns.push({
      name,
      params: [],
      returnType: F64,
      locals: [],
      body: [
        {
          kind: "return",
          value: { kind: "libCall", fn: "perf.now", args: [], type: F64, loc },
          loc,
        },
      ],
      loc,
    });
  }
  return name;
}

/** True when `t` is the PerformanceEntry record (type-mapper's
 * perfEntryShape). */
export function isPerfEntryType(lowerer: Lowerer, t: IrType | null | undefined): boolean {
  if (t?.kind !== "record") return false;
  return lowerer.shapes.get(t.shapeId)?.fields.some((f) => f.name === PERF_ENTRY_MARKER) === true;
}

/** An entry's toJSON() object: { name, entryType, startTime, duration,
 * detail } read off the entry record. */
export function perfEntryJson(
  lowerer: Lowerer,
  entry: IrExpr,
  entryT: IrType & { kind: "record" },
  loc: SrcLoc,
): IrExpr {
  const shape = lowerer.shapes.get(entryT.shapeId)!;
  const read = (name: string): IrExpr => ({
    kind: "recordGet",
    obj: entry,
    shapeId: entryT.shapeId,
    field: name,
    type: shape.fields.find((f) => f.name === name)!.type,
    loc,
  });
  return {
    kind: "recordLit",
    fields: [...PERF_ENTRY_FIELDS].sort().map((name) => ({ name, value: read(name) })),
    type: { kind: "record", shapeId: perfEntryJsonShape(lowerer.shapes) },
    loc,
  };
}

/** One timeline entry of the runtime's last answer, as the entry record. */
function perfEntryRecord(
  lowerer: Lowerer,
  t: IrType & { kind: "record" },
  index: IrExpr,
  loc: SrcLoc,
): IrExpr {
  const marker = lowerer.shapes.get(t.shapeId)!.fields.find((f) => f.name === PERF_ENTRY_MARKER)!;
  const read = (fn: IrLibFn, type: IrType): IrExpr => ({
    kind: "libCall",
    fn,
    args: [index],
    type,
    loc,
  });
  const values: Record<string, IrExpr> = {
    [PERF_ENTRY_MARKER]: lowerer.absentFieldValue(marker.type, loc)!,
    detail: read("perf.entryDetail", DYN),
    duration: read("perf.entryDuration", F64),
    entryType: read("perf.entryType", STRING),
    name: read("perf.entryName", STRING),
    startTime: read("perf.entryStart", F64),
  };
  return {
    kind: "recordLit",
    fields: Object.keys(values)
      .sort()
      .map((name) => ({ name, value: values[name]! })),
    type: t,
    loc,
  };
}

/** The call's arguments as one dyn array, in source order. Spread
 * arguments expand with JavaScript's iterable semantics (strings into
 * characters, Sets, generators and other iterators through the iterator
 * protocol), and a non-iterable spread throws V8's TypeError, so the
 * runtime always receives an array. */
function lowerPerfArguments(lowerer: Lowerer, call: ts.CallExpression, loc: SrcLoc): IrExpr {
  if (!call.arguments.some(ts.isSpreadElement)) {
    return {
      kind: "dynArrLit",
      elems: call.arguments.map((a) => lowerer.lowerExprExpecting(a, DYN)),
      type: DYN,
      loc,
    };
  }
  const pack = lowerer.declareHiddenLocal("%perfArgs", DYN);
  const ref = (): IrExpr => ({ kind: "varRef", localId: pack.id, type: DYN, loc });
  const stmts: IrStmt[] = [
    {
      kind: "varDecl",
      localId: pack.id,
      init: { kind: "dynArrLit", elems: [], type: DYN, loc },
      loc,
    },
  ];
  for (const arg of call.arguments) {
    if (!ts.isSpreadElement(arg)) {
      const value = lowerer.lowerExprExpecting(arg, DYN);
      stmts.push({
        kind: "exprStmt",
        expr: {
          kind: "libCall",
          fn: "dyn.packPush",
          args: [ref(), value],
          type: VOID,
          loc: value.loc,
        },
        loc: value.loc,
      });
      continue;
    }
    const spelling = arg.expression.getText();
    const items = checkedIterableSpread(lowerer, lowerer.lowerExpr(arg.expression), spelling, loc);
    stmts.push({
      kind: "exprStmt",
      expr: {
        kind: "libCall",
        fn: "dyn.packPushSpread",
        args: [ref(), items, { kind: "strLit", value: spelling, type: STRING, loc }],
        type: VOID,
        loc,
      },
      loc,
    });
  }
  return { kind: "seqExpr", stmts, result: ref(), type: DYN, loc };
}

/** performance.mark/measure, getEntries/getEntriesByName/getEntriesByType
 * and clearMarks/clearMeasures. The arguments cross as one dyn vector so
 * the runtime applies Node's validation in Node's order; the producing
 * calls go through a lifted helper per result type that runs the call and
 * builds the entry record(s) from the runtime's answer. */
function lowerPerfTimelineCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  member: string,
  timeline: { fn: IrLibFn; which?: number },
  loc: SrcLoc,
): IrExpr {
  const args = lowerPerfArguments(lowerer, call, loc);
  if (timeline.fn === "perf.clearMarks" || timeline.fn === "perf.clearMeasures") {
    return { kind: "libCall", fn: timeline.fn, args: [args], type: VOID, loc };
  }
  const result = lowerer.mapTypeOf(lowerer.typeOf(call));
  const many = timeline.which !== undefined;
  const entryT = many ? (result?.kind === "array" ? result.elem : undefined) : result;
  if (!isPerfEntryType(lowerer, entryT) || entryT?.kind !== "record" || result == null) {
    lowerer.noLowering(
      `performance.${member} where the result is not a PerformanceEntry${many ? " array" : ""}`,
      call,
    );
  }
  const key = `perf.${many ? "entries" : timeline.fn}:${typeKey(result)}`;
  let helper = lowerer.valueHelpers.get(key);
  if (!helper) {
    helper = `%perf.${many ? "entries" : member}.${lowerer.valueHelpers.size}`;
    lowerer.valueHelpers.set(key, helper);
    const argsRef = varRef("a.0", DYN, loc);
    const whichRef = varRef("w.0", F64, loc);
    const locals: { id: string; name: string; type: IrType; mutable: boolean }[] = [
      { id: "a.0", name: "a", type: DYN, mutable: false },
    ];
    let body: IrStmt[];
    if (!many) {
      // The new entry's record goes back to the runtime by reference, so
      // later getEntries calls answer this same object.
      locals.push({ id: "e.0", name: "e", type: entryT, mutable: false });
      const entry = varRef("e.0", entryT, loc);
      body = [
        {
          kind: "exprStmt",
          expr: { kind: "libCall", fn: timeline.fn, args: [argsRef], type: F64, loc },
          loc,
        },
        {
          kind: "varDecl",
          localId: "e.0",
          init: perfEntryRecord(lowerer, entryT, numLit(0, loc), loc),
          loc,
        },
        {
          kind: "exprStmt",
          expr: {
            kind: "libCall",
            fn: "perf.entryKeep",
            args: [{ kind: "dynFrom", value: entry, liveRef: true, type: DYN, loc }],
            type: VOID,
            loc,
          },
          loc,
        },
        { kind: "return", value: entry, loc },
      ];
    } else {
      locals.push(
        { id: "w.0", name: "w", type: F64, mutable: false },
        { id: "n.0", name: "n", type: F64, mutable: false },
        { id: "out.0", name: "out", type: result, mutable: false },
        { id: "i.0", name: "i", type: F64, mutable: true },
      );
      const index = varRef("i.0", F64, loc);
      const count = varRef("n.0", F64, loc);
      const out = varRef("out.0", result, loc);
      body = [
        {
          kind: "varDecl",
          localId: "n.0",
          init: { kind: "libCall", fn: "perf.entries", args: [argsRef, whichRef], type: F64, loc },
          loc,
        },
        {
          kind: "varDecl",
          localId: "out.0",
          init: { kind: "arrayLit", elems: [], type: result, loc },
          loc,
        },
        {
          kind: "for",
          init: { kind: "varDecl", localId: "i.0", init: numLit(0, loc), loc },
          cond: { kind: "bin", op: "<", left: index, right: count, type: BOOL, loc },
          update: {
            kind: "assign",
            localId: "i.0",
            value: { kind: "bin", op: "+", left: index, right: numLit(1, loc), type: F64, loc },
            loc,
          },
          body: [
            {
              kind: "exprStmt",
              expr: {
                kind: "arrIntrinsic",
                method: "push",
                receiver: out,
                args: [
                  {
                    kind: "dynCheck",
                    value: { kind: "libCall", fn: "perf.entryRef", args: [index], type: DYN, loc },
                    preserveRefs: true,
                    type: entryT,
                    loc,
                  },
                ],
                type: F64,
                loc,
              },
              loc,
            },
          ],
          loc,
        },
        { kind: "return", value: out, loc },
      ];
    }
    lowerer.liftedFns.push({
      name: helper,
      params: [
        { localId: "a.0", name: "a", type: DYN },
        ...(many ? [{ localId: "w.0", name: "w", type: F64 }] : []),
      ],
      returnType: result,
      locals,
      body,
      loc,
    });
  }
  return {
    kind: "call",
    callee: helper,
    args: many ? [args, numLit(timeline.which!, loc)] : [args],
    type: result,
    loc,
  };
}

/** `String(entry)` / `${entry}` / entry.toString(): Object.prototype
 * .toString's tag, "[object PerformanceMark]" or "[object
 * PerformanceMeasure]" (an interned helper, so the entry evaluates once). */
export function perfEntryTag(
  lowerer: Lowerer,
  entry: IrExpr,
  entryT: IrType & { kind: "record" },
  loc: SrcLoc,
): IrExpr {
  const key = `perf.tag:${entryT.shapeId}`;
  let helper = lowerer.valueHelpers.get(key);
  if (!helper) {
    helper = `%perf.tag.${lowerer.valueHelpers.size}`;
    lowerer.valueHelpers.set(key, helper);
    const e = varRef("e.0", entryT, loc);
    lowerer.liftedFns.push({
      name: helper,
      params: [{ localId: "e.0", name: "e", type: entryT }],
      returnType: STRING,
      locals: [{ id: "e.0", name: "e", type: entryT, mutable: false }],
      body: [
        {
          kind: "return",
          value: {
            kind: "ternary",
            cond: {
              kind: "strEq",
              negated: false,
              left: {
                kind: "recordGet",
                obj: e,
                shapeId: entryT.shapeId,
                field: "entryType",
                type: STRING,
                loc,
              },
              right: { kind: "strLit", value: "mark", type: STRING, loc },
              type: BOOL,
              loc,
            },
            then: { kind: "strLit", value: "[object PerformanceMark]", type: STRING, loc },
            else_: { kind: "strLit", value: "[object PerformanceMeasure]", type: STRING, loc },
            type: STRING,
            loc,
          },
          loc,
        },
      ],
      loc,
    });
  }
  return { kind: "call", callee: helper, args: [entry], type: STRING, loc };
}

/** Node keeps an entry's fields as prototype getters over internal
 * slots, so own-key walks (Object.keys/values/entries, for-in, spread,
 * hasOwnProperty) see none of them. Those walks over an entry record
 * fence instead of listing the fields. */
export function fencePerfEntryKeyWalk(
  lowerer: Lowerer,
  t: IrType | null | undefined,
  node: ts.Node,
  what: string,
): void {
  if (!isPerfEntryType(lowerer, t)) return;
  lowerer.unsupported(
    "SC1090",
    node,
    `${what} over performance entries (Node keeps their fields as prototype getters, so own-key walks see none; read the fields or call toJSON())`,
  );
}

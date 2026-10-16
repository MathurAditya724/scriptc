/* node:test's mock functions (Node 24.22, lib/internal/test_runner/mock):
 * mock.fn and t.mock.fn, and the fn.mock context's calls, callCount,
 * mockImplementation, mockImplementationOnce, resetCalls and restore.
 *
 * mock.fn(original, implementation?) lowers to the hybrid record
 * { %call: wrapper, mock: context } (mock-shapes.ts). The wrapper is a
 * closure over the context, lifted once per context type: it takes the
 * one-time implementation registered for this call index, or the current
 * one, calls it, and appends { arguments, error, result, this } to the
 * calls log before returning or rethrowing. The context's mutating
 * methods are lifted helpers of the same type. */
import * as ts from "../ts7/adapter.js";
import {
  BOOL,
  CAUGHT,
  DYN,
  F64,
  UNDEFINED_T,
  VOID,
  typeKey,
  type IrExpr,
  type IrLocal,
  type IrStmt,
  type IrType,
  type SrcLoc,
} from "../../ir/ir.js";
import { countedFor, dynUndefinedExpr, numLit, varRef } from "../../ir/build.js";
import { locOf } from "../program.js";
import type { Lowerer } from "./lowerer.js";

type FuncType = IrType & { kind: "func" };

interface MockContextFields {
  fn: FuncType;
  call: IrType;
  calls: IrType;
  once: IrType;
  onceEntry: IrType;
  result: IrType;
  args: IrType;
}

/** The context record's parts, or null when `type` is not a mock context
 * (mock-shapes.ts). */
function mockContextFields(lowerer: Lowerer, type: IrType): MockContextFields | null {
  if (type.kind !== "record") return null;
  const shape = lowerer.shapes.get(type.shapeId);
  const field = (name: string) => shape?.fields.find((f) => f.name === name)?.type;
  const impl = field("%impl");
  const once = field("%once");
  const calls = field("calls");
  if (
    impl?.kind !== "func" ||
    once?.kind !== "array" ||
    calls?.kind !== "array" ||
    field("%original") === undefined
  )
    return null;
  const call = calls.elem;
  const callShape = call.kind === "record" ? lowerer.shapes.get(call.shapeId) : undefined;
  const result = callShape?.fields.find((f) => f.name === "result")?.type;
  const args = callShape?.fields.find((f) => f.name === "arguments")?.type;
  if (!result || !args) return null;
  return { fn: impl, call, calls, once, onceEntry: once.elem, result, args };
}

export function isMockContextType(lowerer: Lowerer, type: IrType): boolean {
  return mockContextFields(lowerer, type) !== null;
}

const recordGet = (obj: IrExpr, field: string, type: IrType, loc: SrcLoc): IrExpr => ({
  kind: "recordGet",
  obj,
  shapeId: (obj.type as IrType & { kind: "record" }).shapeId,
  field,
  type,
  loc,
});

const recordSet = (obj: IrExpr, field: string, value: IrExpr, loc: SrcLoc): IrStmt => ({
  kind: "recordSet",
  obj,
  shapeId: (obj.type as IrType & { kind: "record" }).shapeId,
  field,
  value,
  loc,
});

const length = (arr: IrExpr, loc: SrcLoc): IrExpr => ({
  kind: "arrIntrinsic",
  method: "length",
  receiver: arr,
  args: [],
  type: F64,
  loc,
});

const local = (id: string, name: string, type: IrType, mutable = false): IrLocal => ({
  id,
  name,
  type,
  mutable,
});

/** Lifts one function per (context type, role), cached on the lowerer. */
function liftOnce(
  lowerer: Lowerer,
  ctxType: IrType,
  role: string,
  build: (name: string) => void,
): string {
  const key = `mock.${role}:${(ctxType as IrType & { kind: "record" }).shapeId}`;
  const existing = lowerer.assertHelpers.get(key);
  if (existing) return existing;
  const name = `%mock.${role}.${lowerer.assertHelpers.size}`;
  lowerer.assertHelpers.set(key, name);
  build(name);
  return name;
}

/** `%mock.wrap.N(ctx)`: the closure that records each call into ctx. */
function mockWrapperFactory(lowerer: Lowerer, ctxType: IrType, loc: SrcLoc): string {
  return liftOnce(lowerer, ctxType, "wrap", (name) => {
    const { fn, call, calls, once, onceEntry, result, args } = mockContextFields(lowerer, ctxType)!;
    const impl = `${name}.impl`;
    const ctx = () => varRef("ctx.0", ctxType, loc);
    const params = fn.params.map((type, i) => ({ localId: `p${i}.0`, name: `p${i}`, type }));
    const paramRefs = () => params.map((p) => varRef(p.localId, p.type, loc));
    const argumentsValue = (): IrExpr =>
      fn.rest
        ? paramRefs()[0]!
        : {
            kind: "recordLit",
            fields: paramRefs().map((value, i) => ({ name: String(i), value })),
            type: args,
            loc,
          };
    const record = (resultValue: IrExpr, error: IrExpr): IrStmt => ({
      kind: "exprStmt",
      expr: {
        kind: "arrIntrinsic",
        method: "push",
        receiver: recordGet(ctx(), "calls", calls, loc),
        args: [
          {
            kind: "recordLit",
            fields: [
              { name: "arguments", value: argumentsValue() },
              { name: "error", value: error },
              { name: "result", value: resultValue },
              { name: "this", value: dynUndefinedExpr(loc) },
            ],
            type: call,
            loc,
          },
        ],
        type: F64,
        loc,
      },
      loc,
    });
    const voidReturn = fn.ret.kind === "void" || fn.ret.kind === "undefinedT";
    // The result slot: a checked-dynamic undefined for void functions, R
    // when R already admits undefined, else the `R | undefined` union.
    const asResult = (value: IrExpr | null): IrExpr => {
      if (result.kind === "dyn") return dynUndefinedExpr(loc);
      if (value !== null && result.kind === "union" && value.type.kind !== "union")
        return {
          kind: "unionWrap",
          unionId: result.unionId,
          tag: lowerer.armTag(result.unionId, value.type),
          value,
          type: result,
          loc,
        };
      if (value !== null) return value;
      const unionId = (result as IrType & { kind: "union" }).unionId;
      return {
        kind: "unionWrap",
        unionId,
        tag: lowerer.armTag(unionId, UNDEFINED_T),
        value: { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc },
        type: result,
        loc,
      };
    };
    const invoke: IrExpr = {
      kind: "callValue",
      callee: varRef("f.0", fn, loc),
      args: paramRefs(),
      type: fn.ret,
      loc,
    };
    const tryBody: IrStmt[] = voidReturn
      ? [
          { kind: "exprStmt", expr: invoke, loc },
          record(asResult(null), dynUndefinedExpr(loc)),
          { kind: "return", value: null, loc },
        ]
      : [
          { kind: "varDecl", localId: "r.0", init: invoke, loc },
          record(asResult(varRef("r.0", fn.ret, loc)), dynUndefinedExpr(loc)),
          { kind: "return", value: varRef("r.0", fn.ret, loc), loc },
        ];
    const catchBody: IrStmt[] = [
      record(asResult(null), {
        kind: "caughtToDyn",
        value: varRef("e.0", CAUGHT, loc),
        type: DYN,
        loc,
      }),
      { kind: "rethrow", localId: "e.0", loc },
    ];
    const onceArray = () => recordGet(ctx(), "%once", once, loc);
    const entry = (j: IrExpr): IrExpr => ({
      kind: "arrayGet",
      arr: onceArray(),
      index: j,
      type: onceEntry,
      loc,
    });
    // The one-time implementation for this call index, used once.
    const pickOnce = countedFor(loc, length(onceArray(), loc), (j) => [
      {
        kind: "if",
        cond: {
          kind: "bin",
          op: "===",
          left: recordGet(entry(j), "at", F64, loc),
          right: varRef("n.0", F64, loc),
          type: BOOL,
          loc,
        },
        then: [
          { kind: "assign", localId: "f.0", value: recordGet(entry(j), "fn", fn, loc), loc },
          {
            kind: "exprStmt",
            expr: {
              kind: "arrIntrinsic",
              method: "splice",
              receiver: onceArray(),
              args: [j, numLit(1, loc)],
              type: once,
              loc,
            },
            loc,
          },
        ],
        else_: null,
        loc,
      },
    ]);
    lowerer.liftedFns.push({
      name: impl,
      params,
      returnType: fn.ret,
      captures: [{ localId: "ctx.0", name: "ctx", type: ctxType }],
      locals: [
        ...params.map((p) => local(p.localId, p.name, p.type)),
        { ...local("ctx.0", "ctx", ctxType), boxed: true },
        local("n.0", "index", F64),
        local("f.0", "implementation", fn, true),
        local("i.0", "entry", F64, true),
        ...(voidReturn ? [] : [local("r.0", "result", fn.ret)]),
        local("e.0", "error", CAUGHT),
      ],
      body: [
        {
          kind: "varDecl",
          localId: "n.0",
          init: length(recordGet(ctx(), "calls", calls, loc), loc),
          loc,
        },
        { kind: "varDecl", localId: "f.0", init: recordGet(ctx(), "%impl", fn, loc), loc },
        pickOnce,
        { kind: "tryCatch", tryBody, catchBody, catchLocalId: "e.0", finallyBody: null, loc },
      ],
      loc,
    });
    lowerer.liftedFns.push({
      name,
      params: [{ localId: "ctx.0", name: "ctx", type: ctxType }],
      returnType: fn,
      locals: [{ ...local("ctx.0", "ctx", ctxType), boxed: true }],
      body: [
        {
          kind: "return",
          value: { kind: "closure", fnName: impl, captures: ["ctx.0"], type: fn, loc },
          loc,
        },
      ],
      loc,
    });
  });
}

/** A VOID helper over the context: `%mock.<role>.N(ctx, ...extra)`. */
function mockHelper(
  lowerer: Lowerer,
  ctxType: IrType,
  role: string,
  extra: { id: string; name: string; type: IrType }[],
  body: (ctx: () => IrExpr, loc: SrcLoc) => IrStmt[],
  loc: SrcLoc,
): string {
  return liftOnce(lowerer, ctxType, role, (name) => {
    const ctx = () => varRef("ctx.0", ctxType, loc);
    lowerer.liftedFns.push({
      name,
      params: [
        { localId: "ctx.0", name: "ctx", type: ctxType },
        ...extra.map((e) => ({ localId: e.id, name: e.name, type: e.type })),
      ],
      returnType: VOID,
      locals: [
        local("ctx.0", "ctx", ctxType),
        ...extra.map((e) => local(e.id, e.name, e.type, true)),
        local("i.0", "entry", F64, true),
      ],
      body: [...body(ctx, loc), { kind: "return", value: null, loc }],
      loc,
    });
  });
}

/** mock.fn(original, implementation?) and t.mock.fn(...). */
export function lowerMockFn(lowerer: Lowerer, call: ts.CallExpression, what: string): IrExpr {
  const loc = locOf(call);
  const mockType = lowerer.mapTypeOf(lowerer.typeOf(call));
  const shape = mockType?.kind === "record" ? lowerer.shapes.get(mockType.shapeId) : undefined;
  const ctxType = shape?.fields.find((f) => f.name === "mock")?.type;
  if (
    !mockType ||
    !shape ||
    shape.fields.length !== 2 ||
    !shape.fields.some((f) => f.name === "%call") ||
    !ctxType ||
    !isMockContextType(lowerer, ctxType)
  ) {
    lowerer.noLowering(
      `${what} of this function type`,
      call,
      "mock functions lower for functions with fixed parameters, or a single rest array parameter",
    );
  }
  const { fn, calls, once, result } = mockContextFields(lowerer, ctxType!)!;
  if (fn.ret.kind === "union" && typeKey(result) !== typeKey(fn.ret)) {
    lowerer.noLowering(
      `${what} of a function returning '${lowerer.fmt(fn.ret)}'`,
      call,
      "a union return type needs an undefined arm here (the calls log records undefined for calls that throw)",
    );
  }
  const args = call.arguments;
  if (args.length === 0 || args.length > 2 || args.some(ts.isSpreadElement)) {
    lowerer.noLowering(
      `${what} with ${args.length} arguments`,
      call,
      "the supported forms are mock.fn(original) and mock.fn(original, implementation); mock.fn() and mock options have no lowering",
    );
  }
  const stmts: IrStmt[] = [];
  const originalLocal = lowerer.declareHiddenLocal("%mockOriginal", fn);
  stmts.push({
    kind: "varDecl",
    localId: originalLocal.id,
    init: lowerer.lowerExprExpecting(args[0]!, fn),
    loc,
  });
  const implementation =
    args.length === 2
      ? lowerer.lowerExprExpecting(args[1]!, fn)
      : varRef(originalLocal.id, fn, loc);
  const ctxLocal = lowerer.declareHiddenLocal("%mockContext", ctxType!);
  stmts.push({
    kind: "varDecl",
    localId: ctxLocal.id,
    init: {
      kind: "recordLit",
      fields: [
        { name: "%impl", value: implementation },
        { name: "%once", value: { kind: "arrayLit", elems: [], type: once, loc } },
        { name: "%original", value: varRef(originalLocal.id, fn, loc) },
        { name: "calls", value: { kind: "arrayLit", elems: [], type: calls, loc } },
      ],
      type: ctxType!,
      loc,
    },
    loc,
  });
  const factory = mockWrapperFactory(lowerer, ctxType!, loc);
  return {
    kind: "seqExpr",
    stmts,
    result: {
      kind: "recordLit",
      fields: [
        {
          name: "%call",
          value: {
            kind: "call",
            callee: factory,
            args: [varRef(ctxLocal.id, ctxType!, loc)],
            type: fn,
            loc,
          },
        },
        { name: "mock", value: varRef(ctxLocal.id, ctxType!, loc) },
      ],
      type: mockType!,
      loc,
    },
    type: mockType!,
    loc,
  };
}

/** `fn.mock.calls`: a copy of the log, as Node's getter returns. Null for
 * other reads. */
export function lowerMockContextProperty(
  lowerer: Lowerer,
  expr: ts.PropertyAccessExpression,
): IrExpr | null {
  if (expr.questionDotToken || expr.name.text !== "calls") return null;
  const receiverType = lowerer.mapTypeOf(lowerer.typeOf(expr.expression));
  if (!receiverType || !isMockContextType(lowerer, receiverType)) return null;
  const { calls } = mockContextFields(lowerer, receiverType)!;
  const loc = locOf(expr);
  return {
    kind: "arrIntrinsic",
    method: "slice",
    receiver: recordGet(lowerer.lowerExpr(expr.expression), "calls", calls, loc),
    args: [],
    type: calls,
    loc,
  };
}

/** The fn.mock context's methods. Null for other receivers. */
export function lowerMockContextCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  const ctxType = lowerer.mapTypeOf(lowerer.typeOf(access.expression));
  if (!ctxType || !isMockContextType(lowerer, ctxType)) return null;
  const { fn, calls, once, onceEntry } = mockContextFields(lowerer, ctxType)!;
  const loc = locOf(call);
  const member = access.name.text;
  const args = call.arguments;
  const arity = (min: number, max: number = min) => {
    if (args.length < min || args.length > max || args.some(ts.isSpreadElement))
      lowerer.noLowering(`MockFunctionContext.${member} with ${args.length} arguments`, call);
  };
  const helperCall = (helper: string, extra: IrExpr[]): IrExpr => ({
    kind: "call",
    callee: helper,
    args: [lowerer.lowerExpr(access.expression), ...extra],
    type: VOID,
    loc,
  });
  switch (member) {
    case "callCount":
      arity(0);
      return length(recordGet(lowerer.lowerExpr(access.expression), "calls", calls, loc), loc);
    case "mockImplementation": {
      arity(1);
      const helper = mockHelper(
        lowerer,
        ctxType,
        "setImplementation",
        [{ id: "f.0", name: "implementation", type: fn }],
        (ctx) => [recordSet(ctx(), "%impl", varRef("f.0", fn, loc), loc)],
        loc,
      );
      return helperCall(helper, [lowerer.lowerExprExpecting(args[0]!, fn)]);
    }
    case "mockImplementationOnce": {
      arity(1, 2);
      // onCall defaults to the next call: the log's length (NaN marks the
      // default). A later registration for the same index replaces it, as
      // Node's Map does.
      const helper = mockHelper(
        lowerer,
        ctxType,
        "setImplementationOnce",
        [
          { id: "f.0", name: "implementation", type: fn },
          { id: "at.0", name: "onCall", type: F64 },
        ],
        (ctx) => {
          const at = () => varRef("at.0", F64, loc);
          const onceArray = () => recordGet(ctx(), "%once", once, loc);
          return [
            {
              kind: "if",
              cond: { kind: "bin", op: "!==", left: at(), right: at(), type: BOOL, loc },
              then: [
                {
                  kind: "assign",
                  localId: "at.0",
                  value: length(recordGet(ctx(), "calls", calls, loc), loc),
                  loc,
                },
              ],
              else_: null,
              loc,
            },
            countedFor(loc, length(onceArray(), loc), (j) => [
              {
                kind: "if",
                cond: {
                  kind: "bin",
                  op: "===",
                  left: recordGet(
                    { kind: "arrayGet", arr: onceArray(), index: j, type: onceEntry, loc },
                    "at",
                    F64,
                    loc,
                  ),
                  right: at(),
                  type: BOOL,
                  loc,
                },
                then: [
                  {
                    kind: "exprStmt",
                    expr: {
                      kind: "arrIntrinsic",
                      method: "splice",
                      receiver: onceArray(),
                      args: [j, numLit(1, loc)],
                      type: once,
                      loc,
                    },
                    loc,
                  },
                ],
                else_: null,
                loc,
              },
            ]),
            {
              kind: "exprStmt",
              expr: {
                kind: "arrIntrinsic",
                method: "push",
                receiver: onceArray(),
                args: [
                  {
                    kind: "recordLit",
                    fields: [
                      { name: "at", value: at() },
                      { name: "fn", value: varRef("f.0", fn, loc) },
                    ],
                    type: onceEntry,
                    loc,
                  },
                ],
                type: F64,
                loc,
              },
              loc,
            },
          ];
        },
        loc,
      );
      return helperCall(helper, [
        lowerer.lowerExprExpecting(args[0]!, fn),
        args.length === 2 ? lowerer.lowerExprExpecting(args[1]!, F64) : numLit(NaN, loc),
      ]);
    }
    case "resetCalls": {
      arity(0);
      const helper = mockHelper(
        lowerer,
        ctxType,
        "resetCalls",
        [],
        (ctx) => [
          recordSet(ctx(), "calls", { kind: "arrayLit", elems: [], type: calls, loc }, loc),
        ],
        loc,
      );
      return helperCall(helper, []);
    }
    case "restore": {
      arity(0);
      const helper = mockHelper(
        lowerer,
        ctxType,
        "restore",
        [],
        (ctx) => [recordSet(ctx(), "%impl", recordGet(ctx(), "%original", fn, loc), loc)],
        loc,
      );
      return helperCall(helper, []);
    }
    default:
      return lowerer.noLowering(
        `MockFunctionContext.${member}`,
        call,
        "calls, callCount, mockImplementation, mockImplementationOnce, resetCalls and restore are the supported mock context members",
      );
  }
}

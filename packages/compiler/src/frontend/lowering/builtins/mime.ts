import * as ts from "../../ts7/adapter.js";
import { type Lowerer } from "../lowerer.js";
import { locOf } from "../../program.js";
import { dynUndefinedExpr, numLit } from "../../../ir/build.js";
import { BOOL, DYN, type IrExpr } from "../../../ir/ir.js";
import { builtinImportOf } from "./module-bindings.js";

/* node:util's MIMEType and MIMEParams are native checked-dynamic handles
 * (scr_mime.c): both types map to dyn, their getters and setters are
 * handle property reads and writes, their methods dispatch through the
 * handle, and these helpers lower the uses a dyn value cannot answer by
 * itself (construction, MIMEType.parse and instanceof). */

type MimeClass = "MIMEType" | "MIMEParams";

/** The MIMEType or MIMEParams class in any node:util spelling. */
export function mimeClassOf(lowerer: Lowerer, node: ts.Expression): MimeClass | null {
  const builtin = ts.isIdentifier(node)
    ? builtinImportOf(lowerer, node)
    : ts.isPropertyAccessExpression(node) && !node.questionDotToken
      ? lowerer.builtinMemberOf(node)
      : null;
  if (builtin?.module !== "util") return null;
  return builtin.member === "MIMEType" || builtin.member === "MIMEParams" ? builtin.member : null;
}

/** The class of a stdlib MIMEType- or MIMEParams-typed value. */
function mimeValueClass(lowerer: Lowerer, node: ts.Expression): MimeClass | null {
  const type = lowerer.typeOf(node);
  const sym = type.getAliasSymbol() ?? type.getSymbol();
  if (!sym) return null;
  const name = ts.symbolName(sym);
  if (name !== "MIMEType" && name !== "MIMEParams") return null;
  return lowerer.isStdlibSymbol(sym) ? name : null;
}

/** Every argument in order, as checked-dynamic values; the first `count`
 * fill the call, missing ones as undefined, and the others still
 * evaluate. */
function mimeArguments(
  lowerer: Lowerer,
  nodes: readonly ts.Expression[],
  count: number,
  loc: ReturnType<typeof locOf>,
): { used: IrExpr[]; extra: IrExpr[] } {
  const values = nodes.map((arg) => lowerer.lowerExprExpecting(arg, DYN));
  const used = values.slice(0, count);
  while (used.length < count) used.push(dynUndefinedExpr(loc));
  return { used, extra: values.slice(count) };
}

/** The call, after which any surplus arguments evaluate. */
function withSurplus(
  lowerer: Lowerer,
  call: IrExpr,
  extra: IrExpr[],
  loc: ReturnType<typeof locOf>,
): IrExpr {
  if (extra.length === 0) return call;
  const local = lowerer.declareHiddenLocal("%mimeResult", call.type);
  return {
    kind: "seqExpr",
    stmts: [
      { kind: "varDecl", localId: local.id, init: call, loc },
      ...extra.map((arg) => ({ kind: "exprStmt" as const, expr: arg, loc: arg.loc })),
    ],
    result: { kind: "varRef", localId: local.id, type: call.type, loc },
    type: call.type,
    loc,
  };
}

/** `new MIMEType(string[, noThrow])` and `new MIMEParams()`. */
export function lowerMimeNew(lowerer: Lowerer, expr: ts.NewExpression): IrExpr | null {
  const cls = mimeClassOf(lowerer, expr.expression);
  if (cls === null) return null;
  const nodes = expr.arguments?.nodes ?? [];
  if (nodes.some(ts.isSpreadElement)) return null;
  const loc = locOf(expr);
  const { used, extra } = mimeArguments(lowerer, nodes, cls === "MIMEType" ? 2 : 0, loc);
  const call: IrExpr = {
    kind: "libCall",
    fn: cls === "MIMEType" ? "mime.typeNew" : "mime.paramsNew",
    args: used,
    type: DYN,
    loc,
  };
  return withSurplus(lowerer, call, extra, loc);
}

const INSTANCE_METHODS: Record<MimeClass, ReadonlySet<string>> = {
  MIMEType: new Set(["toString", "toJSON"]),
  MIMEParams: new Set([
    "get",
    "has",
    "set",
    "delete",
    "entries",
    "keys",
    "values",
    "toString",
    "toJSON",
  ]),
};

/** MIMEType.parse(), and the instance methods, which the handle answers
 * as methods, so they dispatch through dynInvoke rather than as a member
 * read and a call. */
export function lowerMimeCall(lowerer: Lowerer, call: ts.CallExpression): IrExpr | null {
  if (call.questionDotToken || !ts.isPropertyAccessExpression(call.expression)) return null;
  const access = call.expression;
  if (access.questionDotToken || call.arguments.nodes.some(ts.isSpreadElement)) return null;
  const name = access.name.text;
  const loc = locOf(call);
  if (name === "parse" && mimeClassOf(lowerer, access.expression) === "MIMEType") {
    const { used, extra } = mimeArguments(lowerer, call.arguments.nodes, 1, loc);
    return withSurplus(
      lowerer,
      { kind: "libCall", fn: "mime.typeParse", args: used, type: DYN, loc },
      extra,
      loc,
    );
  }
  const cls = mimeValueClass(lowerer, access.expression);
  if (cls === null || !INSTANCE_METHODS[cls].has(name)) return null;
  return {
    kind: "dynInvoke",
    recv: lowerer.lowerExprExpecting(access.expression, DYN),
    method: name,
    calleeName: ts.getTextOfNode(access),
    args: call.arguments.nodes.map((arg) => lowerer.lowerExprExpecting(arg, DYN)),
    type: DYN,
    loc,
  };
}

/** `v instanceof MIMEType` / `v instanceof MIMEParams`. */
export function lowerMimeInstanceof(lowerer: Lowerer, expr: ts.BinaryExpression): IrExpr | null {
  const cls = mimeClassOf(lowerer, expr.right);
  if (cls === null) return null;
  const loc = locOf(expr);
  const value = lowerer.coerceInto(expr.left, lowerer.lowerExpr(expr.left), DYN);
  return {
    kind: "libCall",
    fn: "mime.is",
    args: [value, numLit(cls === "MIMEType" ? 0 : 1, loc)],
    type: BOOL,
    loc,
  };
}

/** `params`, `params.keys()`, `params.values()` or `params.entries()` over a
 * MIMEParams: its checked-dynamic view iterates the live entry list, like
 * URLSearchParams (isSearchParamsIterable). */
export function isMimeParamsIterable(lowerer: Lowerer, node: ts.Expression): boolean {
  while (ts.isParenthesizedExpression(node)) node = node.expression;
  if (mimeValueClass(lowerer, node) === "MIMEParams") return true;
  if (
    !ts.isCallExpression(node) ||
    node.arguments.nodes.length !== 0 ||
    !ts.isPropertyAccessExpression(node.expression)
  )
    return false;
  const name = node.expression.name.text;
  return (
    (name === "keys" || name === "values" || name === "entries") &&
    mimeValueClass(lowerer, node.expression.expression) === "MIMEParams"
  );
}

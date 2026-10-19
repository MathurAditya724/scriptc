import * as ts from "../../ts7/adapter.js";
import { type Lowerer, PoisonError } from "../lowerer.js";
import { locOf } from "../../program.js";
import { webAssemblyDiag } from "../../../diagnostics/diagnostic.js";
import { STRING, type IrExpr } from "../../../ir/ir.js";
import { stdlibGlobalNameOf } from "../surfaces.js";

/* The WebAssembly API. scriptc.d.ts declares its types (lib.dom's
 * namespace) so that packages whose declarations mention them typecheck,
 * and the type mapper gives those types the checked-dynamic representation.
 * No module compiles to native code yet, so every reached use of the API
 * value fences at its expression with webAssemblyDiag: a build error in
 * TypeScript sources, a located runtime fence in JavaScript ones. typeof
 * needs no value and folds to Node's answer. */

/** Strips the spellings that leave a value unchanged: parentheses, type
 * assertions, `satisfies` and non-null assertions. */
function bare(expr: ts.Expression): ts.Expression {
  for (;;) {
    if (ts.isParenthesizedExpression(expr) || ts.isNonNullExpression(expr)) expr = expr.expression;
    else if (ts.isAsExpression(expr) || ts.isTypeAssertion(expr)) expr = expr.expression;
    else if (ts.isSatisfiesExpression(expr)) expr = expr.expression;
    else return expr;
  }
}

/** The global object itself, as `globalThis` or `global` spells it. */
function isGlobalThis(lowerer: Lowerer, expr: ts.Expression): boolean {
  const node = bare(expr);
  return (
    ts.isIdentifier(node) &&
    (node.text === "globalThis" || node.text === "global") &&
    stdlibGlobalNameOf(lowerer, node) === "globalThis"
  );
}

/** THE WebAssembly namespace value: `WebAssembly` or `globalThis.WebAssembly`
 * (and the global object reached through a cast, as in
 * `(globalThis as any).WebAssembly`). */
function isWebAssemblyGlobal(lowerer: Lowerer, expr: ts.Expression): boolean {
  expr = bare(expr);
  if (ts.isIdentifier(expr)) {
    return expr.text === "WebAssembly" && stdlibGlobalNameOf(lowerer, expr) === "WebAssembly";
  }
  if (ts.isPropertyAccessExpression(expr)) {
    return expr.name.text === "WebAssembly" && isGlobalThis(lowerer, expr.expression);
  }
  if (ts.isElementAccessExpression(expr)) {
    const key = expr.argumentExpression;
    return (
      (ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key)) &&
      key.text === "WebAssembly" &&
      isGlobalThis(lowerer, expr.expression)
    );
  }
  return false;
}

/** The surface a WebAssembly API expression names ('WebAssembly',
 * 'globalThis.WebAssembly', 'WebAssembly.compile'), or null. A cheap
 * spelling check runs first: almost every expression is rejected without a
 * checker query. */
function webAssemblySurface(lowerer: Lowerer, expr: ts.Expression): string | null {
  // `globalThis as unknown as { WebAssembly: ... }`: the cast's target type
  // names the member, and the value it checks is the global object's
  // WebAssembly (the spelling pi's codemode uses).
  if (
    (ts.isAsExpression(expr) || ts.isTypeAssertion(expr)) &&
    isGlobalThis(lowerer, expr.expression)
  ) {
    const target = lowerer.checker.getTypeAtLocation(expr.type);
    return lowerer.checker.getPropertyOfType(target, "WebAssembly") !== undefined
      ? "globalThis.WebAssembly"
      : null;
  }
  const node = bare(expr);
  if (ts.isIdentifier(node)) {
    return node.text === "WebAssembly" && isWebAssemblyGlobal(lowerer, node) ? "WebAssembly" : null;
  }
  if (ts.isPropertyAccessExpression(node)) {
    if (node.name.text === "WebAssembly") {
      return isWebAssemblyGlobal(lowerer, node) ? "globalThis.WebAssembly" : null;
    }
    // WebAssembly.<member>, and members of members
    // (WebAssembly.Module.customSections).
    const names = [node.name.text];
    let receiver = bare(node.expression);
    while (ts.isPropertyAccessExpression(receiver) && receiver.name.text !== "WebAssembly") {
      names.unshift(receiver.name.text);
      receiver = bare(receiver.expression);
    }
    const spelled =
      (ts.isIdentifier(receiver) && receiver.text === "WebAssembly") ||
      (ts.isPropertyAccessExpression(receiver) && receiver.name.text === "WebAssembly");
    return spelled && isWebAssemblyGlobal(lowerer, receiver)
      ? `WebAssembly.${names.join(".")}`
      : null;
  }
  if (ts.isElementAccessExpression(node)) {
    return isWebAssemblyGlobal(lowerer, node) ? "globalThis.WebAssembly" : null;
  }
  return null;
}

/** Fences a reached use of the WebAssembly API. `prefix` qualifies a
 * construction ('new '). Returns normally when `expr` is anything else. */
export function refuseWebAssemblyUse(lowerer: Lowerer, expr: ts.Expression, prefix = ""): void {
  const surface = webAssemblySurface(lowerer, expr);
  if (surface === null) return;
  lowerer.pushDiag(webAssemblyDiag(`${prefix}${surface}`, locOf(expr)));
  throw new PoisonError();
}

/** `typeof WebAssembly` is "object" and `typeof WebAssembly.<member>` is
 * "function" for every member the namespace declares, as in Node. The
 * operand is an effect-free global read, so nothing else evaluates. */
export function lowerWebAssemblyTypeof(lowerer: Lowerer, operand: ts.Expression): IrExpr | null {
  const surface = webAssemblySurface(lowerer, operand);
  if (surface === null) return null;
  const loc = locOf(operand);
  if (surface === "WebAssembly" || surface === "globalThis.WebAssembly") {
    return { kind: "strLit", value: "object", type: STRING, loc };
  }
  const t = lowerer.typeOf(operand);
  if (
    lowerer.checker.getCallSignatures(t).length > 0 ||
    lowerer.checker.getConstructSignatures(t).length > 0
  ) {
    return { kind: "strLit", value: "function", type: STRING, loc };
  }
  return null;
}

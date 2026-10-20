/* Array spreads whose elements nothing else can reach. */
import * as ts from "../../ts7/adapter.js";
import type { IrExpr, IrType, SrcLoc } from "../../../ir/ir.js";
import type { Lowerer } from "../lowerer.js";

/** Whether the elements a spread inserts are reachable only through it: an
 * array literal (`...(cond ? [{ ... }] : [])`), or a const initialized by
 * one that this spread is the only reference to. Converting such elements
 * into the destination's element layout copies them, which nothing can
 * observe. */
export function freshSpreadSource(lowerer: Lowerer, node: ts.Expression): boolean {
  let e = node;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  if (ts.isArrayLiteralExpression(e))
    return e.elements.nodes.every(
      (x) => !ts.isSpreadElement(x) && (ts.isObjectLiteralExpression(x) || !isReference(x)),
    );
  if (ts.isConditionalExpression(e))
    return freshSpreadSource(lowerer, e.whenTrue) && freshSpreadSource(lowerer, e.whenFalse);
  if (!ts.isIdentifier(e)) return false;
  const symbol = lowerer.resolveValueSymbol(e);
  const decl = symbol?.valueDeclaration;
  if (!symbol || !decl || !ts.isVariableDeclaration(decl) || !decl.initializer) return false;
  const list = decl.parent;
  if (!ts.isVariableDeclarationList(list) || (list.flags & ts.NodeFlags.Const) === 0) return false;
  if (!freshSpreadSource(lowerer, decl.initializer)) return false;
  // The binding's only use is this spread.
  let scope: ts.Node = list;
  while (scope.parent && !ts.isBlock(scope) && !ts.isSourceFile(scope)) scope = scope.parent;
  let uses = 0;
  const visit = (n: ts.Node): void => {
    if (uses > 1) return;
    if (ts.isIdentifier(n) && n !== decl.name && n.text === e.text) {
      if (lowerer.resolveValueSymbol(n) === symbol) uses++;
    }
    ts.forEachChild(n, visit);
  };
  visit(scope);
  return uses === 1;
}

function isReference(e: ts.Expression): boolean {
  return !(
    ts.isStringLiteral(e) ||
    ts.isNumericLiteral(e) ||
    e.kind === ts.SyntaxKind.TrueKeyword ||
    e.kind === ts.SyntaxKind.FalseKeyword ||
    e.kind === ts.SyntaxKind.NullKeyword
  );
}

/** A fresh array spread converted into the destination's array layout by
 * the structural width lift, or null when the layouts do not lift. */
export function liftedFreshSpread(
  lowerer: Lowerer,
  node: ts.Expression,
  source: IrExpr,
  arrType: IrType,
  loc: SrcLoc,
): IrExpr | null {
  if (source.type.kind !== "array" || arrType.kind !== "array") return null;
  if (!freshSpreadSource(lowerer, node)) return null;
  const lift = lowerer.widthLiftPlan(source.type, arrType);
  return lift ? lowerer.applyWidthLift(lift, source, arrType, loc) : null;
}

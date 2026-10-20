/* A module export called through its module binding (`m.f()` where `m` is
 * `const m = require("./x")` or `import * as m from "./x"`): Node passes
 * the module object (the exports object, or the namespace) as `this`. The
 * member call lowers to a direct call of the exported function, which has
 * no module object to pass, so an export that reads `this` refuses instead
 * of seeing another receiver. */
import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";

/** The function an export binding holds, when its declaration shows it. */
function exportedFunction(decl: ts.Node): ts.Node | null {
  let node: ts.Node | undefined = decl;
  if (ts.isPropertyAccessExpression(node) && node.parent && ts.isBinaryExpression(node.parent))
    node = node.parent;
  if (ts.isBinaryExpression(node)) node = node.right;
  else if (ts.isVariableDeclaration(node) || ts.isPropertyAssignment(node)) node = node.initializer;
  while (node !== undefined && ts.isParenthesizedExpression(node)) node = node.expression;
  if (node === undefined) return null;
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isMethodDeclaration(node)
  )
    return node;
  return null;
}

/** Whether a function's own body reads `this` (arrows share it; other
 * functions and classes have their own). */
function readsOwnThis(fn: ts.Node): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (node.kind === ts.SyntaxKind.ThisKeyword) {
      found = true;
      return;
    }
    if ((ts.isFunctionLike(node) && !ts.isArrowFunction(node)) || ts.isClassLikeDeclaration(node))
      return;
    node.forEachChild(visit);
  };
  fn.forEachChild(visit);
  return found;
}

export function refuseModuleMemberThis(
  lowerer: Lowerer,
  call: ts.CallExpression,
  member: ts.Identifier,
): void {
  let symbol = lowerer.checker.getSymbolAtLocation(member);
  if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0)
    symbol = lowerer.checker.getAliasedSymbol(symbol);
  if (symbol === undefined) return;
  for (const decl of symbol.declarations) {
    const fn = exportedFunction(decl);
    if (fn === null || !readsOwnThis(fn)) continue;
    lowerer.unsupported(
      "SC1090",
      call,
      `calling a module export that reads 'this' through its module binding ('${member.text}': Node passes the module object as 'this', which this call has no value for)`,
    );
  }
}

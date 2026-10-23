import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";

/** Date methods whose receiver is only read for its time value: a Date
 * local used as their receiver can store the time value instead of a Date
 * object (builtins/dates.ts lowers them). */
const TIME_VALUE_METHODS = new Set([
  "getTime",
  "valueOf",
  "toISOString",
  "toJSON",
  "toString",
  "toDateString",
  "toTimeString",
  "toUTCString",
  "getFullYear",
  "getUTCFullYear",
  "getMonth",
  "getUTCMonth",
  "getDate",
  "getUTCDate",
  "getDay",
  "getUTCDay",
  "getHours",
  "getUTCHours",
  "getMinutes",
  "getUTCMinutes",
  "getSeconds",
  "getUTCSeconds",
  "getMilliseconds",
  "getUTCMilliseconds",
  "getTimezoneOffset",
]);

const RELATIONAL = new Set([
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
]);

/** True when a local `const` (or a `let` that is never assigned again)
 * holding a Date can keep the Date's time value instead of a Date object:
 * no use observes the Date's identity. Every use reads the time value as
 * a Date method receiver, a String() or template operand, a relational or
 * string `+` operand, or `new Date(d)`'s argument, inside the declaring
 * function, or inside the block or loop that scopes a module-level
 * binding (no closure captures it). Top-level module bindings keep the
 * object. Other uses box the time value into a new Date at the use. */
export function isTimeValueDateDeclaration(
  lowerer: Lowerer,
  decl: ts.VariableDeclaration,
): boolean {
  const known = lowerer.timeValueDateDecisions.get(decl);
  if (known !== undefined) return known;
  const answer = decideTimeValueDate(lowerer, decl);
  lowerer.timeValueDateDecisions.set(decl, answer);
  return answer;
}

function decideTimeValueDate(lowerer: Lowerer, decl: ts.VariableDeclaration): boolean {
  if (!ts.isIdentifier(decl.name) || decl.initializer === undefined) return false;
  const sf = decl.getSourceFile();
  if (sf.isDeclarationFile || /\.[cm]?jsx?$/.test(sf.fileName)) return false;
  const list = decl.parent;
  if (!ts.isVariableDeclarationList(list)) return false;
  const isConst = (list.flags & ts.NodeFlags.Const) !== 0;
  const isLet = (list.flags & ts.NodeFlags.Let) !== 0;
  if (!isConst && !isLet) return false;
  if (!ts.isVariableStatement(list.parent) && !ts.isForStatement(list.parent)) return false;
  const fn = enclosingFunction(decl);
  // The uses to check: the function body, or for a binding inside a block
  // or loop at module level (a local of the module's initializer, not a
  // module binding) the block or loop that scopes it.
  let scope: ts.Node | undefined;
  if (fn !== null) scope = fn.body;
  else if (!inClassStaticBlock(decl)) scope = moduleBlockScope(decl);
  if (scope === undefined) return false;
  // The lib Date interface by its symbol first: mapping every candidate
  // binding's type would intern its unions before the lowering does.
  const typeSymbol = lowerer.typeOf(decl.name).getSymbol();
  if (
    typeSymbol === undefined ||
    ts.symbolName(typeSymbol) !== "Date" ||
    !typeSymbol.declarations.some(
      (d) => ts.isInterfaceDeclaration(d) && lowerer.isStdlibFile(d.getSourceFile()),
    )
  )
    return false;
  if (lowerer.mapTypeOf(lowerer.typeOf(decl.name))?.kind !== "date") return false;
  const symbol = lowerer.checker.getSymbolAtLocation(decl.name);
  if (!symbol) return false;
  let ok = true;
  const visit = (node: ts.Node): void => {
    if (!ok) return;
    if (ts.isIdentifier(node) && node !== decl.name && node.text === decl.name.text) {
      if (lowerer.checker.getSymbolAtLocation(node) === symbol) {
        if (enclosingFunction(node) !== fn || !readsTimeValue(lowerer, node)) ok = false;
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(scope);
  return ok;
}

/** The block or for statement that scopes a module-level binding which is
 * not a module binding: a declaration in a block or loop body, or in a
 * for statement's initializer. Undefined for a top-level declaration. */
function moduleBlockScope(decl: ts.VariableDeclaration): ts.Node | undefined {
  const list = decl.parent;
  if (!list || !ts.isVariableDeclarationList(list)) return undefined;
  if (ts.isForStatement(list.parent)) return list.parent;
  const statement = list.parent;
  if (!ts.isVariableStatement(statement) || ts.isSourceFile(statement.parent)) return undefined;
  for (let cur: ts.Node | undefined = statement.parent; cur; cur = cur.parent) {
    if (ts.isBlock(cur) || ts.isCaseBlock(cur)) return cur;
    if (ts.isSourceFile(cur)) return undefined;
  }
  return undefined;
}

function inClassStaticBlock(node: ts.Node): boolean {
  for (let cur = node.parent; cur; cur = cur.parent) {
    if (ts.isClassStaticBlockDeclaration(cur)) return true;
    if (ts.isSourceFile(cur)) return false;
  }
  return false;
}

function enclosingFunction(node: ts.Node): ts.FunctionLikeDeclaration | null {
  for (let cur = node.parent; cur; cur = cur.parent) {
    if (
      ts.isFunctionDeclaration(cur) ||
      ts.isFunctionExpression(cur) ||
      ts.isArrowFunction(cur) ||
      ts.isMethodDeclaration(cur) ||
      ts.isConstructorDeclaration(cur) ||
      ts.isGetAccessorDeclaration(cur) ||
      ts.isSetAccessorDeclaration(cur)
    )
      return cur;
    if (ts.isClassStaticBlockDeclaration(cur) || ts.isSourceFile(cur)) return null;
  }
  return null;
}

/** A use of the binding that reads only its time value. */
function readsTimeValue(lowerer: Lowerer, id: ts.Identifier): boolean {
  let node: ts.Node = id;
  while (ts.isParenthesizedExpression(node.parent)) node = node.parent;
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
    const call = parent.parent;
    return (
      !parent.questionDotToken &&
      ts.isCallExpression(call) &&
      call.expression === parent &&
      !call.questionDotToken &&
      TIME_VALUE_METHODS.has(parent.name.text) &&
      lowerer.isStdlibMember(parent)
    );
  }
  if (ts.isTemplateSpan(parent)) return parent.expression === node;
  if (ts.isCallExpression(parent)) {
    return (
      parent.arguments.nodes.length === 1 &&
      parent.arguments.nodes[0] === node &&
      ts.isIdentifier(parent.expression) &&
      lowerer.isStdlibGlobal(parent.expression, "String")
    );
  }
  if (ts.isNewExpression(parent)) {
    return (
      parent.arguments?.nodes.length === 1 &&
      parent.arguments.nodes[0] === node &&
      ts.isIdentifier(parent.expression) &&
      lowerer.isStdlibGlobal(parent.expression, "Date")
    );
  }
  if (ts.isBinaryExpression(parent)) {
    const other = parent.left === node ? parent.right : parent.left;
    const otherKind = lowerer.mapTypeOf(lowerer.typeOf(other))?.kind;
    if (RELATIONAL.has(parent.operatorToken.kind)) return otherKind === "date";
    if (parent.operatorToken.kind === ts.SyntaxKind.PlusToken) return otherKind === "string";
  }
  return false;
}

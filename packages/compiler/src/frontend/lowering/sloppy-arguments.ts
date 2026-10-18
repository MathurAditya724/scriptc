import * as ts from "../ts7/adapter.js";
import { argumentsReadsOf } from "../arguments-usage.js";
import { paramWrittenInBody } from "./generic-functions.js";
import { hasUseStrictDirective } from "./lower-stmts.js";
import type { Lowerer } from "./lowerer.js";

/** Why a parameterized function's `arguments` cannot use the unmapped
 * hidden array: the node to blame and the refused feature. */
export interface SloppyArgumentsRefusal {
  node: ts.Node;
  reason: string;
}

const MAPPED = "in a sloppy-mode function (mapped 'arguments' aliases its parameters)";
const UNMAPPED = "in a function with parameters outside an ES module";

/** Decides whether a JavaScript function with parameters outside an ES
 * module may read `arguments` through the hidden array of actual
 * arguments. That array is a snapshot, so it is exact only while nothing
 * writes it or inspects it as an object:
 *   - `arguments` is used only as `arguments.length`, an rvalue
 *     `arguments[i]`, `...arguments`, `f.apply(x, arguments)` (an untyped
 *     `f` is taken to be a function, the forwarding idiom's assumption),
 *     `Array.prototype.slice.call(arguments[, n])`,
 *     or `Array.from(arguments[, fn])` — none can write it or let it escape.
 * Node's object is UNMAPPED in strict code and when the parameter list is
 * not simple (defaults, rest, patterns); those functions are admitted on
 * that condition alone. Sloppy-mode functions with simple parameter lists
 * get a MAPPED object, whose elements alias the parameters, so they also
 * need:
 *   - no parameter that some read can reach (a constant index, or every
 *     index for the other forms) is ever written, including by closures.
 * Returns null when admitted, else the precise refusal. Only functions
 * that reach the non-module fence run this analysis. */
export function sloppyArgumentsRefusal(
  lowerer: Lowerer,
  fn: ts.SignatureDeclaration,
): SloppyArgumentsRefusal | null {
  const params = fn.parameters;
  if (params.length === 0 || fn.body === undefined) return null;
  // A default, rest, or destructuring parameter makes the list non-simple,
  // and Node then creates an unmapped arguments object even in sloppy mode.
  const unmapped =
    params.some(
      (p) =>
        !ts.isIdentifier(p.name) || p.initializer !== undefined || p.dotDotDotToken !== undefined,
    ) || isStrictCode(fn);
  const where = unmapped ? UNMAPPED : MAPPED;
  let readsAll = false;
  const readIndices = new Set<number>();
  for (const id of argumentsReadsOf(fn)) {
    const symbol = lowerer.checker.getSymbolAtLocation(id);
    const declaration = symbol ? lowerer.checker.valueDeclarationOf(symbol) : undefined;
    if (declaration !== undefined) {
      return { node: id, reason: `a binding named 'arguments' ${where}` };
    }
    const use = classifyUse(lowerer, id);
    switch (use.kind) {
      case "write":
        return { node: use.node, reason: `writing 'arguments' ${where}` };
      case "escape":
        return { node: use.node, reason: `${use.what} ${where}` };
      case "index":
        readIndices.add(use.index);
        break;
      case "all":
        readsAll = true;
        break;
      case "none":
        break;
    }
  }
  if (unmapped) return null;
  const names = new Set<string>();
  for (const [index, param] of params.entries()) {
    const name = (param.name as ts.Identifier).text;
    if (names.has(name)) {
      return { node: param, reason: `a duplicate parameter name ${MAPPED}` };
    }
    names.add(name);
    if (!readsAll && !readIndices.has(index)) continue;
    const symbol = lowerer.checker.getSymbolAtLocation(param.name);
    if (symbol === undefined || paramWrittenInBody(lowerer, fn.body, symbol, name)) {
      return {
        node: param,
        reason: `writing parameter '${name}' while reading it through 'arguments' ${MAPPED}`,
      };
    }
  }
  return null;
}

type ArgumentsUse =
  | { kind: "none" }
  | { kind: "index"; index: number }
  | { kind: "all" }
  | { kind: "write"; node: ts.Node }
  | { kind: "escape"; node: ts.Node; what: string };

function classifyUse(lowerer: Lowerer, id: ts.Identifier): ArgumentsUse {
  let node: ts.Node = id;
  while (ts.isParenthesizedExpression(node.parent)) node = node.parent;
  const access = accessKind(node);
  if (access === "write") return { kind: "write", node };
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
    if (parent.name.text !== "length") {
      return { kind: "escape", node: parent, what: `'arguments.${parent.name.text}'` };
    }
    const lengthAccess = accessKind(parent);
    if (lengthAccess === "write") return { kind: "write", node: parent };
    if (lengthAccess === "call") {
      return { kind: "escape", node: parent, what: "calling a member of 'arguments'" };
    }
    return { kind: "none" };
  }
  if (ts.isElementAccessExpression(parent) && parent.expression === node) {
    const elementAccess = accessKind(parent);
    if (elementAccess === "write") return { kind: "write", node: parent };
    if (elementAccess === "call") {
      return { kind: "escape", node: parent, what: "calling a member of 'arguments'" };
    }
    const index = constantIndex(parent.argumentExpression);
    return index === null ? { kind: "all" } : { kind: "index", index };
  }
  if (
    ts.isSpreadElement(parent) &&
    (ts.isCallExpression(parent.parent) ||
      ts.isNewExpression(parent.parent) ||
      ts.isArrayLiteralExpression(parent.parent))
  ) {
    return { kind: "all" };
  }
  if (ts.isCallExpression(parent) && parent.expression !== node) {
    const callee = parent.expression;
    const args = parent.arguments;
    if (
      args.length === 2 &&
      args[1] === node &&
      ts.isPropertyAccessExpression(callee) &&
      callee.name.text === "apply" &&
      isFunctionApply(lowerer, callee)
    ) {
      return { kind: "all" };
    }
    if (args[0] === node && args.length <= 2 && isArraySliceCall(lowerer, callee)) {
      return { kind: "all" };
    }
    if (
      args[0] === node &&
      args.length <= 2 &&
      ts.isPropertyAccessExpression(callee) &&
      callee.name.text === "from" &&
      lowerer.isStdlibGlobal(callee.expression, "Array")
    ) {
      return { kind: "all" };
    }
  }
  return { kind: "escape", node, what: "'arguments' as a value" };
}

/** How an expression position uses its value: a write target (assignment,
 * compound assignment, ++/--, delete, a destructuring-assignment or
 * for-in/of target), a call/tagged-template callee (the callee receives
 * the object as `this`), or a plain read. */
function accessKind(expr: ts.Node): "read" | "write" | "call" {
  let node = expr;
  while (ts.isParenthesizedExpression(node.parent)) node = node.parent;
  const parent = node.parent;
  if (ts.isDeleteExpression(parent)) return "write";
  if (
    (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
    (parent.operator === ts.SyntaxKind.PlusPlusToken ||
      parent.operator === ts.SyntaxKind.MinusMinusToken)
  ) {
    return "write";
  }
  if (
    (ts.isCallExpression(parent) || ts.isTaggedTemplateExpression(parent)) &&
    parent.expression === node
  ) {
    return "call";
  }
  // Climb a destructuring-assignment pattern to its root.
  let target = node;
  for (;;) {
    const up = target.parent;
    if (
      ts.isArrayLiteralExpression(up) ||
      ts.isObjectLiteralExpression(up) ||
      ts.isSpreadElement(up) ||
      ts.isSpreadAssignment(up) ||
      ts.isShorthandPropertyAssignment(up) ||
      ts.isParenthesizedExpression(up) ||
      (ts.isPropertyAssignment(up) && up.initializer === target)
    ) {
      target = up;
      continue;
    }
    break;
  }
  const root = target.parent;
  if (ts.isBinaryExpression(root) && root.left === target) {
    const k = root.operatorToken.kind;
    if (k >= ts.SyntaxKind.FirstAssignment && k <= ts.SyntaxKind.LastAssignment) return "write";
  }
  if ((ts.isForInStatement(root) || ts.isForOfStatement(root)) && root.initializer === target) {
    return "write";
  }
  return "read";
}

/** `f.apply` where `apply` is Function.prototype.apply: the member resolves
 * to the standard library, or the receiver is an untyped JavaScript value
 * (`var emit = process.emit`), which the forwarding idiom calls for its
 * function value. A typed receiver declaring its own `apply` is an escape. */
function isFunctionApply(lowerer: Lowerer, callee: ts.PropertyAccessExpression): boolean {
  if (lowerer.isStdlibMember(callee)) return true;
  return (
    lowerer.checker.getSymbolAtLocation(callee.name) === undefined &&
    (lowerer.typeOf(callee.expression).flags & ts.TypeFlags.Any) !== 0
  );
}

/** `Array.prototype.slice.call` on the global Array. (`[].slice.call`
 * stays an escape: its `[].slice` read does not lower to the prototype
 * method.) */
function isArraySliceCall(lowerer: Lowerer, callee: ts.Expression): boolean {
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "call") return false;
  const slice = callee.expression;
  if (!ts.isPropertyAccessExpression(slice) || slice.name.text !== "slice") return false;
  const owner = slice.expression;
  return (
    ts.isPropertyAccessExpression(owner) &&
    owner.name.text === "prototype" &&
    lowerer.isStdlibGlobal(owner.expression, "Array")
  );
}

/** A literal array index (`arguments[1]`, `arguments["1"]`), else null. */
function constantIndex(expr: ts.Expression): number | null {
  let text: string;
  if (ts.isNumericLiteral(expr)) text = String(Number(expr.text));
  else if (ts.isStringLiteral(expr)) text = expr.text;
  else return null;
  const index = Number(text);
  return Number.isInteger(index) && index >= 0 && String(index) === text ? index : null;
}

/** Class bodies, functions with a 'use strict' directive, and everything
 * nested in them are strict code; so is a file whose prologue says so. */
function isStrictCode(fn: ts.Node): boolean {
  for (let node: ts.Node | undefined = fn; node; node = node.parent) {
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) return true;
    if (ts.isSourceFile(node)) return hasUseStrictDirective(node.statements);
    if (
      ts.isFunctionLike(node) &&
      node.body !== undefined &&
      ts.isBlock(node.body) &&
      hasUseStrictDirective(node.body.statements)
    ) {
      return true;
    }
  }
  return false;
}

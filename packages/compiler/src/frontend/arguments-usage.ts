import * as ts from "./ts7/adapter.js";

/** Whether an identifier in a function body reads the runtime arguments object. */
function isArgumentsRead(id: ts.Identifier): boolean {
  const parent = id.parent;
  // A shorthand object property reads its value, but other `name` positions
  // declare a binding or spell a property (including `o.arguments`).
  if (ts.isShorthandPropertyAssignment(parent)) return true;
  if ((parent as ts.Node & { name?: ts.Node }).name === id) return false;
  if (ts.isBindingElement(parent) && parent.propertyName === id) return false;
  if (ts.isLabeledStatement(parent) && parent.label === id) return false;
  if ((ts.isBreakStatement(parent) || ts.isContinueStatement(parent)) && parent.label === id)
    return false;
  return true;
}

/** Does this function's own body read `arguments`? Nested plain functions and
 * methods own theirs; arrows inherit the enclosing one. */
export function bodyReadsArguments(fn: ts.Node): boolean {
  if (fn.body === undefined) return false;
  let found = false;
  // Iterative walking preserves the frontend's nesting fence on deep trees.
  ts.walkPreorder(fn.body, (node) => {
    if (ts.isTypeNode(node)) return "skip";
    if (ts.isIdentifier(node) && node.text === "arguments" && isArgumentsRead(node)) {
      found = true;
      return "stop";
    }
    if (ts.isFunctionLike(node) && !ts.isArrowFunction(node) && node !== fn) {
      return "skip";
    }
    return undefined;
  });
  return found;
}

/** Every identifier in this function's own body (arrows included, nested
 * plain functions and methods excluded) that reads `arguments` — the
 * bodyReadsArguments walk, collecting instead of stopping at the first. */
export function argumentsReadsOf(fn: ts.Node): ts.Identifier[] {
  const reads: ts.Identifier[] = [];
  if (fn.body === undefined) return reads;
  ts.walkPreorder(fn.body, (node) => {
    if (ts.isTypeNode(node)) return "skip";
    if (ts.isIdentifier(node) && node.text === "arguments" && isArgumentsRead(node)) {
      reads.push(node);
      return undefined;
    }
    if (ts.isFunctionLike(node) && !ts.isArrowFunction(node) && node !== fn) {
      return "skip";
    }
    return undefined;
  });
  return reads;
}

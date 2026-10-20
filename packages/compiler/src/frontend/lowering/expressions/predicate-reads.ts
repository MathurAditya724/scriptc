/* Member reads through a reference that a hand-written type predicate or
 * assertion function (`x is T`, `asserts x is T`) may have narrowed.
 * TypeScript trusts such a claim without checking it, so the stored value can
 * still hold another of its declared types. Node then reads the member from
 * the value it holds: a member that type lacks reads undefined, and one it has
 * reads its own value. The read keeps the typed read for the claimed arm and
 * reads any other value through one checked-dynamic read, so its result admits
 * undefined, like an unchecked element read (the runtime-optional analysis
 * widens the slots it reaches). */
import * as ts from "../../ts7/adapter.js";
import type { Lowerer } from "../lowerer.js";
import { BOOL, DYN, STRING, UNDEFINED_T, isUnitType, typeEquals } from "../../../ir/ir.js";
import type { IrExpr, IrType, SrcLoc } from "../../../ir/ir.js";
import { locOf } from "../../program.js";
import { checkedNarrowOperand } from "../coercions/unions.js";
import { isSafeToRepeat } from "./evaluation-safety.js";
import { armLacksMember, v8CalleeText } from "./narrowing.js";

const active = new Set<ts.Node>();

/** A predicate-narrowed read whose receiver can hold another present value,
 * so the read can answer undefined where its type does not admit it. */
export function predicateReadMayBeUndefined(
  lowerer: Lowerer,
  expr: ts.PropertyAccessExpression,
): boolean {
  if (!isPredicateNarrowedRead(lowerer, expr)) return false;
  const receiver = peel(expr.expression);
  const declared = lowerer.narrowing.declaredTypeOf(receiver);
  if (declared === null) return true;
  const present = lowerer.mapTypeOf(lowerer.checker.getNonNullableType(declared));
  const claimed = lowerer.mapTypeOf(lowerer.typeOf(receiver));
  return present === null || claimed === null || !typeEquals(present, claimed);
}

/** A plain member read (not a call's callee, a store target, a `delete`
 * operand or an optional chain link) whose receiver a hand-written predicate
 * or assertion may have narrowed. */
export function isPredicateNarrowedRead(
  lowerer: Lowerer,
  expr: ts.PropertyAccessExpression,
): boolean {
  if (expr.questionDotToken || ts.isPrivateIdentifier(expr.name)) return false;
  let child: ts.Node = expr;
  let parent = expr.parent;
  while (ts.isParenthesizedExpression(parent)) {
    child = parent;
    parent = parent.parent;
  }
  if ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression === child)
    return false;
  if (
    ts.isBinaryExpression(parent) &&
    parent.left === child &&
    isAssignment(parent.operatorToken.kind)
  )
    return false;
  if (ts.isDeleteExpression(parent)) return false;
  if (
    (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
    (parent.operator === ts.SyntaxKind.PlusPlusToken ||
      parent.operator === ts.SyntaxKind.MinusMinusToken)
  )
    return false;
  if (ts.isPropertyAccessExpression(parent) && parent.questionDotToken) return false;
  if (inOptionalChain(expr.expression)) return false;
  return lowerer.narrowing.predicateClaim(peel(expr.expression));
}

/** A receiver the claim narrowed: the test that it holds the claimed type,
 * the receiver's whole value, and the types of the other values it can hold. */
interface Claim {
  claimed: IrExpr;
  value: IrExpr;
  others: IrType[];
}

/** The claim on `receiver`, or null when the receiver does not lower to a
 * checked extraction of a union arm or a checked class downcast. */
function claimOf(lowerer: Lowerer, claimed: IrExpr): Claim | null {
  // A class claim: `value instanceof C ? value as C : throw`.
  if (
    claimed.kind === "ternary" &&
    claimed.cond.kind === "instanceOf" &&
    claimed.then.kind === "downcast" &&
    claimed.then.value === claimed.cond.value
  ) {
    const value = claimed.cond.value;
    if (!isSafeToRepeat(value)) return null;
    return { claimed: claimed.cond, value, others: [value.type] };
  }
  const operand = checkedNarrowOperand(lowerer, claimed);
  if (operand === null || operand.type.kind !== "union" || !isSafeToRepeat(operand)) return null;
  const unionId = operand.type.unionId;
  const tag = lowerer.armTag(unionId, claimed.type);
  const arms = lowerer.unions.get(unionId)?.arms;
  if (tag < 0 || !arms) return null;
  return {
    claimed: {
      kind: "unionIsTag",
      unionId,
      tag,
      negated: false,
      value: operand,
      type: BOOL,
      loc: operand.loc,
    },
    value: operand,
    others: arms.filter((_, t) => t !== tag),
  };
}

/** `typed` when the receiver holds the claimed type, otherwise `other`, the
 * checked-dynamic answer for whatever value it holds; null when either does
 * not have the type `type`. */
function byClaim(
  claim: Claim,
  typed: IrExpr,
  other: IrExpr,
  type: IrType,
  loc: SrcLoc,
): IrExpr | null {
  if (!typeEquals(typed.type, type) || !typeEquals(other.type, type)) return null;
  return { kind: "ternary", cond: claim.claimed, then: typed, else_: other, type, loc };
}

/** The read of `expr` through a predicate-narrowed receiver, or null when the
 * receiver's value is not a union the claim picked an arm of. `lowerTyped`
 * lowers the ordinary read, whose receiver is the checked extraction of the
 * claimed arm. */
export function lowerPredicateNarrowedRead(
  lowerer: Lowerer,
  expr: ts.PropertyAccessExpression,
  lowerTyped: () => IrExpr,
): IrExpr | null {
  if (active.has(expr) || !isPredicateNarrowedRead(lowerer, expr)) return null;
  const receiver = peel(expr.expression);
  active.add(expr);
  try {
    const loc = locOf(expr);
    const name = expr.name.text;
    const value = lowerer.lowerExpr(receiver);
    // A claimed catch binding is a checked-dynamic value (caughtRead).
    if (value.type.kind === "dyn") {
      const type = readType(lowerer, lowerer.mapTypeOf(lowerer.typeOf(expr)) ?? DYN);
      return type && dynRead(lowerer, value, name, type, loc);
    }
    const claim = claimOf(lowerer, value);
    if (claim === null) return null;
    const typed = lowerTyped();
    // Reads of null or undefined throw, so only another present value can
    // make the read answer something its type does not admit.
    const type = claim.others.every(isUnitType) ? typed.type : readType(lowerer, typed.type);
    if (type === null) return null;
    return byClaim(
      claim,
      lowerer.coerceToExpected(typed, type),
      dynRead(lowerer, claim.value, name, type, loc),
      type,
      loc,
    );
  } finally {
    active.delete(expr);
  }
}

/** The call `call` of a method on a predicate-narrowed receiver, or null.
 * Other values invoke the method as Node does: a value without it throws
 * `v.m is not a function` after the arguments evaluate, and an object with it
 * answers that method's result. Arguments with nested functions or classes
 * keep the checked receiver extraction, since the call lowers them twice, and
 * so does a primitive that has the method, which has no checked-dynamic
 * invocation. */
export function lowerPredicateNarrowedCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  lowerTyped: () => IrExpr,
): IrExpr | null {
  if (active.has(call) || call.questionDotToken) return null;
  const callee = peel(call.expression);
  if (
    !ts.isPropertyAccessExpression(callee) ||
    callee.questionDotToken ||
    ts.isPrivateIdentifier(callee.name)
  )
    return null;
  const receiver = peel(callee.expression);
  if (inOptionalChain(receiver) || !lowerer.narrowing.predicateClaim(receiver)) return null;
  const args = call.arguments?.nodes ?? [];
  if (args.some((arg) => ts.isSpreadElement(arg) || definesCode(arg))) return null;
  active.add(call);
  try {
    const loc = locOf(call);
    const name = callee.name.text;
    const invoke = (value: IrExpr, type: IrType): IrExpr =>
      lowerer.coerceToExpected(
        {
          kind: "dynInvoke",
          recv: asDyn(value, loc),
          method: name,
          calleeName: v8CalleeText(callee),
          args: args.map((arg) => lowerer.lowerExprExpecting(arg, DYN)),
          type: DYN,
          loc,
        },
        type,
      );
    const value = lowerer.lowerExpr(receiver);
    // A claimed catch binding is a checked-dynamic value (caughtRead).
    if (value.type.kind === "dyn") {
      const type = lowerer.mapTypeOf(lowerer.typeOf(call));
      return type && invoke(value, type);
    }
    const claim = claimOf(lowerer, value);
    if (claim === null) return null;
    if (
      claim.others.some((arm) => isPrimitive(arm) && !armLacksMember(lowerer, receiver, arm, name))
    )
      return null;
    const typed = lowerTyped();
    return byClaim(claim, typed, invoke(claim.value, typed.type), typed.type, loc);
  } finally {
    active.delete(call);
  }
}

/** The claimed read's type widened to admit undefined, or null when it has
 * no undefined-armed form. */
function readType(lowerer: Lowerer, type: IrType): IrType | null {
  if (type.kind === "dyn") return type;
  if (type.kind === "union" && lowerer.armTag(type.unionId, UNDEFINED_T) >= 0) return type;
  const widened = lowerer.runtimeOptionalType(type);
  return widened.kind === "union" && lowerer.armTag(widened.unionId, UNDEFINED_T) >= 0
    ? widened
    : null;
}

/** Node's read of `name` from `value` as a checked-dynamic value: null and
 * undefined throw Node's TypeError, a missing member reads undefined. */
function dynRead(lowerer: Lowerer, value: IrExpr, name: string, type: IrType, loc: SrcLoc): IrExpr {
  return lowerer.coerceToExpected(
    {
      kind: "dynKeyGet",
      key: { kind: "strLit", value: name, type: STRING, loc },
      value: asDyn(value, loc),
      type: DYN,
      loc,
    },
    type,
  );
}

function asDyn(value: IrExpr, loc: SrcLoc): IrExpr {
  return value.type.kind === "dyn" ? value : { kind: "dynFrom", value, type: DYN, loc };
}

/** `node` contains a function or class, whose lowering defines code. */
function definesCode(node: ts.Node): boolean {
  let found = false;
  ts.walkPreorder(node, (inner) => {
    if (ts.isFunctionLike(inner) || ts.isClassLikeDeclaration(inner)) {
      found = true;
      return "skip";
    }
    return undefined;
  });
  return found;
}

function isPrimitive(type: IrType): boolean {
  return (
    type.kind === "f64" || type.kind === "bool" || type.kind === "string" || type.kind === "bigint"
  );
}

/** `node` is a link of an optional chain (`a?.b.c`), which lowers only as
 * part of the whole chain. */
function inOptionalChain(node: ts.Expression): boolean {
  for (let e = peel(node); ;) {
    if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) {
      if (e.questionDotToken) return true;
      e = peel(e.expression);
    } else if (ts.isCallExpression(e)) {
      if (e.questionDotToken) return true;
      e = peel(e.expression);
    } else if (ts.isNonNullExpression(e)) {
      e = peel(e.expression);
    } else return false;
  }
}

function peel(node: ts.Expression): ts.Expression {
  let e = node;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  return e;
}

function isAssignment(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

/* Member reads through a reference that a hand-written type predicate or
 * assertion function (`x is T`, `asserts x is T`) may have narrowed.
 * TypeScript trusts such a claim without checking it, so the stored value can
 * still hold another of its declared types. Node then reads the member from
 * the value it holds: a member that type lacks reads undefined, and one it has
 * reads its own value. The read keeps the typed read for the claimed arm and
 * reads every other arm as Node does, so its result admits undefined, like an
 * unchecked element read (the runtime-optional analysis widens the slots it
 * reaches). */
import * as ts from "../../ts7/adapter.js";
import type { Lowerer } from "../lowerer.js";
import { BOOL, DYN, STRING, UNDEFINED_T, isUnitType, typeEquals } from "../../../ir/ir.js";
import type { IrExpr, IrType, SrcLoc } from "../../../ir/ir.js";
import { nodeThrowExpr } from "../../../ir/build.js";
import { locOf } from "../../program.js";
import { OTHER_ARM_FAILURE_MESSAGE, checkedNarrowOperand } from "../coercions/unions.js";
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
  return lowerer.narrowing.predicateClaim(peel(expr.expression));
}

/** A receiver the claim narrowed: the test that it holds the claimed type,
 * and every other value it can hold, with the test that selects each. */
interface Claim {
  claimed: IrExpr;
  others: { arm: IrType; value: IrExpr; test: IrExpr }[];
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
    return { claimed: claimed.cond, others: [{ arm: value.type, value, test: claimed.cond }] };
  }
  const operand = checkedNarrowOperand(lowerer, claimed);
  if (operand === null || operand.type.kind !== "union" || !isSafeToRepeat(operand)) return null;
  const unionId = operand.type.unionId;
  const tag = lowerer.armTag(unionId, claimed.type);
  const arms = lowerer.unions.get(unionId)?.arms;
  if (tag < 0 || !arms) return null;
  const loc = operand.loc;
  const isTag = (t: number): IrExpr => ({
    kind: "unionIsTag",
    unionId,
    tag: t,
    negated: false,
    value: operand,
    type: BOOL,
    loc,
  });
  return {
    claimed: isTag(tag),
    others: arms.flatMap((arm, t) =>
      t === tag
        ? []
        : [
            {
              arm,
              value: { kind: "unionNarrow", unionId, tag: t, value: operand, type: arm, loc },
              test: isTag(t),
            },
          ],
    ),
  };
}

/** `typed` when the receiver holds the claimed type, otherwise `other`'s
 * answer for the value it holds, as one expression of type `type`. */
function byArm(
  claim: Claim,
  typed: IrExpr,
  other: (arm: IrType, value: IrExpr) => IrExpr,
  type: IrType,
  loc: SrcLoc,
): IrExpr {
  let result: IrExpr | null = null;
  for (let i = claim.others.length - 1; i >= 0; i--) {
    const { arm, value, test } = claim.others[i]!;
    const answer = other(arm, value);
    result =
      result === null
        ? answer
        : { kind: "ternary", cond: test, then: answer, else_: result, type, loc };
  }
  if (result === null) return typed;
  return { kind: "ternary", cond: claim.claimed, then: typed, else_: result, type, loc };
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
      return type && otherArmRead(lowerer, receiver, value, DYN, name, type, loc);
    }
    const claim = claimOf(lowerer, value);
    if (claim === null) return null;
    const typed = lowerTyped();
    // Reads of null or undefined throw, so only another present value can
    // make the read answer something its type does not admit.
    const type = claim.others.every(({ arm }) => isUnitType(arm))
      ? typed.type
      : readType(lowerer, typed.type);
    if (type === null) return null;
    return byArm(
      claim,
      lowerer.coerceToExpected(typed, type),
      (arm, value) => otherArmRead(lowerer, receiver, value, arm, name, type, loc),
      type,
      loc,
    );
  } finally {
    active.delete(expr);
  }
}

/** The call `call` of a method on a predicate-narrowed receiver, or null.
 * Other arms invoke the method as Node does: a value without it throws
 * `v.m is not a function` after the arguments evaluate, and one with it
 * answers that method's result. Arguments with nested functions or classes
 * keep the checked receiver extraction, since the call lowers them for each
 * arm. */
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
  if (!lowerer.narrowing.predicateClaim(receiver)) return null;
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
          recv: value.type.kind === "dyn" ? value : { kind: "dynFrom", value, type: DYN, loc },
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
    const typed = lowerTyped();
    const type = typed.type;
    return byArm(
      claim,
      typed,
      (arm, other) => {
        if (isUnitType(arm)) return unitReadError(arm, name, type, loc);
        // A primitive's own methods have no checked-dynamic invocation.
        if (isPrimitive(arm) && !armLacksMember(lowerer, receiver, arm, name))
          return nodeThrowExpr(1, "", OTHER_ARM_FAILURE_MESSAGE, type, loc);
        return invoke(other, type);
      },
      type,
      loc,
    );
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

/** Node's read of `name` from `value`, another value the receiver holds. */
function otherArmRead(
  lowerer: Lowerer,
  receiver: ts.Expression,
  value: IrExpr,
  arm: IrType,
  name: string,
  type: IrType,
  loc: SrcLoc,
): IrExpr {
  if (isUnitType(arm)) return unitReadError(arm, name, type, loc);
  // A primitive lacking the member reads undefined; objects can be of any
  // subclass, so they read the member themselves.
  if (isPrimitive(arm) && armLacksMember(lowerer, receiver, arm, name)) {
    return lowerer.coerceToExpected(
      { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc },
      type,
    );
  }
  return lowerer.coerceToExpected(
    {
      kind: "dynKeyGet",
      key: { kind: "strLit", value: name, type: STRING, loc },
      value: value.type.kind === "dyn" ? value : { kind: "dynFrom", value, type: DYN, loc },
      type: DYN,
      loc,
    },
    type,
  );
}

/** Node's TypeError for reading `name` from null or undefined. */
function unitReadError(arm: IrType, name: string, type: IrType, loc: SrcLoc): IrExpr {
  const unit = arm.kind === "nullT" ? "null" : "undefined";
  return nodeThrowExpr(1, "", `Cannot read properties of ${unit} (reading '${name}')`, type, loc);
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

function peel(node: ts.Expression): ts.Expression {
  let e = node;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  return e;
}

function isAssignment(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

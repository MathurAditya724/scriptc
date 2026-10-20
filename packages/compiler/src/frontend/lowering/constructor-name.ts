import * as ts from "../ts7/adapter.js";
import { BOOL, DYN, STRING, type IrExpr } from "../../ir/ir.js";
import { dynUndefinedExpr, strLit, varRef } from "../../ir/build.js";
import { isJsSourceFile, locOf } from "../program.js";
import type { Lowerer } from "./lowerer.js";
import type { ClassInfo } from "./lower-classes.js";
import { tryLowerExpression } from "./expressions/try-lower-expression.js";

/** `value.constructor.name`: the name of the class that constructed the
 * value.
 *
 * - A TypeScript program class without subclasses answers its name at
 *   compile time, as `C.name` does.
 * - Other program class instances in TypeScript read `constructor` and then
 *   `name` through the instance's checked-dynamic view, which JavaScript
 *   sources already use for `value.constructor`.
 * - An error-typed value tests the program's error classes that extend its
 *   static class, most derived first, and otherwise answers the native
 *   error's builtin class name.
 * - An untyped value reads `constructor` and then `name`. A value that holds
 *   a native error answers the error's class name, since a native error has
 *   no constructor value to read.
 *
 * Answers null for other receivers, which keep their existing lowering. */
export function lowerConstructorName(
  lowerer: Lowerer,
  expr: ts.PropertyAccessExpression,
): IrExpr | null {
  if (expr.name.text !== "name" || expr.questionDotToken) return null;
  let access = expr.expression;
  while (ts.isParenthesizedExpression(access)) access = access.expression;
  if (
    !ts.isPropertyAccessExpression(access) ||
    access.name.text !== "constructor" ||
    access.questionDotToken ||
    access.expression.kind === ts.SyntaxKind.SuperKeyword
  )
    return null;
  const target = access.expression;
  const js = isJsSourceFile(expr.getSourceFile());
  let declared = lowerer.mapTypeOf(lowerer.typeOf(target));
  // An unannotated JavaScript parameter has no mapped type; its lowered
  // value says whether it is untyped.
  let lowered: IrExpr | null = null;
  if (declared === null) {
    if (!js) return null;
    lowered = tryLowerExpression(lowerer, target);
    if (lowered?.type.kind !== "dyn") return null;
    declared = DYN;
  }
  const loc = locOf(expr);
  const asString = !js && lowerer.mapTypeOf(lowerer.typeOf(expr))?.kind === "string";
  if (declared.kind === "dyn") {
    const slot = lowerer.declareHiddenLocal("%constructorNameReceiver", DYN);
    const constructorSlot = lowerer.declareHiddenLocal("%constructorNameConstructor", DYN);
    const value = (): IrExpr => varRef(slot.id, DYN, loc);
    const constructor = (): IrExpr => varRef(constructorSlot.id, DYN, loc);
    const name: IrExpr = {
      kind: "libCall",
      fn: "dyn.errorConstructorName",
      args: [
        value(),
        constructor(),
        {
          kind: "dynKeyGet",
          value: constructor(),
          key: strLit("name", loc),
          optional: true,
          type: DYN,
          loc,
        },
      ],
      type: DYN,
      loc,
    };
    const result = asString ? lowerer.coerceToExpected(name, STRING) : name;
    return {
      kind: "seqExpr",
      stmts: [
        { kind: "varDecl", localId: slot.id, init: lowered ?? lowerer.lowerExpr(target), loc },
        {
          kind: "varDecl",
          localId: constructorSlot.id,
          init: {
            kind: "dynKeyGet",
            value: value(),
            key: strLit("constructor", loc),
            type: DYN,
            loc,
          },
          loc,
        },
      ],
      result,
      type: result.type,
      loc,
    };
  }
  if (declared.kind !== "object") return null;
  const info = lowerer.classes.get(declared.className);
  const programClass = info !== undefined && !info.def.runtime ? info : undefined;
  if (programClass?.fields.has("constructor")) return null;
  if (lowerer.errorHierarchyClassOf(declared.className)) {
    if (programClass && js) return null;
    return errorConstructorName(lowerer, target, declared.className, programClass, loc);
  }
  if (!programClass || js) return null;
  if (programClass.subclasses.length === 0 && programClass.def.jsName !== undefined && asString) {
    return {
      kind: "seqExpr",
      stmts: [{ kind: "exprStmt", expr: lowerer.lowerExpr(target), loc }],
      result: strLit(programClass.def.jsName, loc),
      type: STRING,
      loc,
    };
  }
  if (!asString || !lowerer.dynConvertible(declared)) return null;
  const slot = lowerer.declareHiddenLocal("%constructorNameReceiver", DYN);
  const value = varRef(slot.id, DYN, loc);
  return {
    kind: "seqExpr",
    stmts: [
      {
        kind: "varDecl",
        localId: slot.id,
        init: lowerer.coerceToExpected(lowerer.lowerExpr(target), DYN),
        loc,
      },
    ],
    result: lowerer.coerceToExpected(constructorNameRead(value, loc), STRING),
    type: STRING,
    loc,
  };
}

/** `value.constructor.name` read through the checked-dynamic tree. */
function constructorNameRead(value: IrExpr, loc: IrExpr["loc"]): IrExpr {
  return {
    kind: "dynKeyGet",
    value: { kind: "dynKeyGet", value, key: strLit("constructor", loc), type: DYN, loc },
    key: strLit("name", loc),
    type: DYN,
    loc,
  };
}

/** The constructor name of an error-typed value. */
function errorConstructorName(
  lowerer: Lowerer,
  target: ts.Expression,
  className: string,
  programClass: ClassInfo | undefined,
  loc: IrExpr["loc"],
): IrExpr | null {
  const receiver = lowerer.lowerExpr(target);
  if (receiver.type.kind !== "object") return null;
  const type = receiver.type;
  const extendsStatic = (candidate: ClassInfo): boolean => {
    for (let c: ClassInfo | null = candidate; c; c = c.base) {
      if (c.def.name === className) return true;
    }
    return false;
  };
  const depth = (candidate: ClassInfo): number => {
    let n = 0;
    for (let c = candidate.base; c; c = c.base) n++;
    return n;
  };
  const candidates = [...lowerer.classes.values()]
    .filter(
      (candidate) =>
        !candidate.def.runtime &&
        candidate.def.jsName !== undefined &&
        candidate.decl != null &&
        extendsStatic(candidate),
    )
    .sort((a, b) => depth(b) - depth(a));
  if (candidates.some((candidate) => candidate.fields.has("constructor"))) return null;
  const slot = lowerer.declareHiddenLocal("%constructorNameReceiver", type);
  const value = (): IrExpr => varRef(slot.id, type, loc);
  // A program class is the most general candidate of its own hierarchy, so
  // it answers when no subclass matches. A builtin static class falls back
  // to the native error's class.
  let result: IrExpr =
    programClass?.def.jsName !== undefined && candidates.at(-1) === programClass
      ? strLit(programClass.def.jsName, loc)
      : lowerer.coerceToExpected(
          {
            kind: "libCall",
            fn: "dyn.errorConstructorName",
            args: [
              lowerer.coerceToExpected(value(), DYN),
              dynUndefinedExpr(loc),
              dynUndefinedExpr(loc),
            ],
            type: DYN,
            loc,
          },
          STRING,
        );
  const tested = result.kind === "strLit" ? candidates.slice(0, -1) : candidates;
  for (const candidate of tested.toReversed()) {
    result = {
      kind: "ternary",
      cond: { kind: "instanceOf", value: value(), className: candidate.def.name, type: BOOL, loc },
      then: strLit(candidate.def.jsName!, loc),
      else_: result,
      type: STRING,
      loc,
    };
  }
  return {
    kind: "seqExpr",
    stmts: [{ kind: "varDecl", localId: slot.id, init: receiver, loc }],
    result,
    type: STRING,
    loc,
  };
}

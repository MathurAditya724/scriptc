import * as ts from "../ts7/adapter.js";
import { locOf } from "../program.js";
import type { IrExpr } from "../../ir/ir.js";
import type { Lowerer } from "./lowerer.js";
import { accessorCall } from "./lower-classes.js";
import { classSymbolKeyOf } from "./symbol-fields.js";

/** A stable symbol method uses the same completed arguments and virtual
 * dispatch as a string-named class method. Runtime-selected keys stay on
 * the checked-property path. */
export function lowerClassSymbolMethodCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
): IrExpr | null {
  const access = call.expression;
  if (!ts.isElementAccessExpression(access) || access.questionDotToken || call.questionDotToken)
    return null;
  const key = classSymbolKeyOf(lowerer, access.argumentExpression);
  if (!key) return null;
  const type = lowerer.mapTypeOf(lowerer.typeOf(access.expression));
  if (type?.kind !== "object") return null;
  const info = lowerer.classes.get(type.className);
  const name = info?.symbolMethods?.get(key.identity);
  if (!name) return null;
  const method = lowerer.findMethodOn(info ?? null, name);
  if (!method) return null;
  const loc = locOf(call);
  const receiver = lowerer.lowerExpr(access.expression);
  const args = lowerer.completeArgs(call.arguments.nodes, method.sig.params, loc, call);
  return accessorCall(lowerer, type.className, name, receiver, args, method.sig.ret, loc);
}

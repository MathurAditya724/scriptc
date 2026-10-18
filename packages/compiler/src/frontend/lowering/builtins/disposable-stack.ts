import * as ts from "../../ts7/adapter.js";
import { type Lowerer } from "../lowerer.js";
import { locOf } from "../../program.js";
import { newFnCtx } from "../function-context.js";
import { BOOL, DYN, VOID, type IrExpr, type IrType } from "../../../ir/ir.js";
import { varRef } from "../../../ir/build.js";

type StackClass = "DisposableStack" | "AsyncDisposableStack";

const STACK_CLASSES: readonly StackClass[] = ["DisposableStack", "AsyncDisposableStack"];

/** The standard-library stack class `node`'s static type names, or null. */
function stdlibStackClassOf(lowerer: Lowerer, node: ts.Expression): StackClass | null {
  const type = lowerer.checker.getBaseTypeOfLiteralType(lowerer.typeOf(node));
  for (const symbol of [type.getSymbol(), type.getAliasSymbol()]) {
    const name = STACK_CLASSES.find((cls) => cls === symbol?.name);
    if (name && symbol && lowerer.isStdlibSymbol(symbol)) return name;
  }
  return null;
}

/** `new DisposableStack()` and `new AsyncDisposableStack()`: native stack
 * handles (scr_symbol.c, scr_async_disposable.c). Their members are
 * function values and getters of the handle, reached through the
 * checked-dynamic method and property paths. Null for other constructors. */
export function lowerDisposableStackNew(lowerer: Lowerer, expr: ts.NewExpression): IrExpr | null {
  if (!ts.isIdentifier(expr.expression)) return null;
  const text = expr.expression.text;
  const name = STACK_CLASSES.find((cls) => cls === text);
  if (!name) return null;
  const symbol = lowerer.resolveValueSymbol(expr.expression);
  if (!symbol || !lowerer.isStdlibSymbol(symbol)) return null;
  if ((expr.arguments ?? []).length !== 0) return null;
  return {
    kind: "libCall",
    fn: name === "DisposableStack" ? "disposable.stackNew" : "disposable.asyncStackNew",
    args: [],
    type: DYN,
    loc: locOf(expr),
  };
}

/** `x instanceof DisposableStack` and `x instanceof AsyncDisposableStack`,
 * or null when the right side is neither standard-library class. */
export function lowerDisposableStackInstanceOf(
  lowerer: Lowerer,
  expr: ts.BinaryExpression,
): IrExpr | null {
  const name = STACK_CLASSES.find((cls) => lowerer.isStdlibGlobal(expr.right, cls));
  if (!name) return null;
  const value = lowerer.coerceInto(expr.left, lowerer.lowerExpr(expr.left), DYN);
  return {
    kind: "libCall",
    fn: name === "DisposableStack" ? "disposable.stackIs" : "disposable.asyncStackIs",
    args: [value],
    type: BOOL,
    loc: locOf(expr),
  };
}

/** `stack.use(value)` where `value` is a class instance. The dyn view of a
 * class instance has no methods, so the stack receives a function that
 * calls the class's [Symbol.dispose] method on the value (on an
 * AsyncDisposableStack, its [Symbol.asyncDispose] method when it has one,
 * whose promise the disposal awaits), and the call answers the value at
 * its static type. Other values take the checked-dynamic method path,
 * which reads the value's methods. Null when the call is not that form. */
export function lowerDisposableStackUseCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (call.questionDotToken || access.questionDotToken) return null;
  if (access.name.text !== "use" || call.arguments.length !== 1) return null;
  const argNode = call.arguments[0]!;
  if (ts.isSpreadElement(argNode)) return null;
  const stackClass = stdlibStackClassOf(lowerer, access.expression);
  if (!stackClass) return null;
  const valueT = lowerer.mapTypeOf(lowerer.typeOf(argNode));
  if (valueT?.kind === "union") {
    const arms = lowerer.unions.get(valueT.unionId)?.arms ?? [];
    if (arms.some((arm) => arm.kind === "object")) {
      lowerer.unsupported(
        "SC1090",
        argNode,
        "DisposableStack.use on a union with class instances (narrow the value to the class first)",
      );
    }
  }
  if (valueT?.kind !== "object") return null;
  const loc = locOf(call);
  const className = valueT.className;
  const info = lowerer.classes.get(className);
  if (!info) lowerer.flushDeferredClass(className);
  const asyncFound =
    stackClass === "AsyncDisposableStack" && info
      ? lowerer.findMethodOn(info, "sym:asyncDispose")
      : null;
  const member = asyncFound ? "sym:asyncDispose" : "sym:dispose";
  const found = asyncFound ?? (info ? lowerer.findMethodOn(info, "sym:dispose") : null);
  if (!found) return null;
  const memberText = asyncFound ? "[Symbol.asyncDispose]" : "[Symbol.dispose]";
  if (found.sig.params.length !== 0) {
    lowerer.unsupported("SC1090", argNode, `${memberText} methods with parameters`);
  }
  if (asyncFound && found.sig.ret.kind !== "promise") {
    lowerer.unsupported("SC1090", argNode, `${memberText} methods whose result is not a Promise`);
  }
  const helperRet: IrType = asyncFound ? found.sig.ret : VOID;
  const stack = lowerer.lowerExpr(access.expression);
  const value = lowerer.lowerExpr(argNode);
  const key = `disposableStack.use:${member}:${className}`;
  let helper = lowerer.valueHelpers.get(key);
  if (!helper) {
    helper = `%disposableStack.use.${lowerer.valueHelpers.size}`;
    lowerer.valueHelpers.set(key, helper);
    const context = newFnCtx(false, null, null, helperRet);
    lowerer.fnStack.push(context);
    try {
      const param = lowerer.declareHiddenLocal("value", valueT);
      const self = varRef(param.id, valueT, loc);
      const call = lowerer.accessorCall(className, member, self, [], found.sig.ret, loc);
      lowerer.liftedFns.push({
        name: helper,
        params: [{ localId: param.id, name: "value", type: valueT }],
        returnType: helperRet,
        locals: context.locals,
        body: [
          asyncFound ? { kind: "return", value: call, loc } : { kind: "exprStmt", expr: call, loc },
        ],
        loc,
      });
    } finally {
      lowerer.fnStack.pop();
    }
  }
  const stackLocal = lowerer.declareHiddenLocal("%disposableStack", DYN);
  const valueLocal = lowerer.declareHiddenLocal("%disposableValue", valueT);
  const fnT: IrType = { kind: "func", params: [valueT], ret: helperRet };
  const dispose: IrExpr = { kind: "closure", fnName: helper, captures: [], type: fnT, loc };
  return {
    kind: "seqExpr",
    stmts: [
      { kind: "varDecl", localId: stackLocal.id, init: stack, loc },
      { kind: "varDecl", localId: valueLocal.id, init: value, loc },
      {
        kind: "exprStmt",
        expr: {
          kind: "libCall",
          fn: "disposable.stackUseCallback",
          args: [
            varRef(stackLocal.id, DYN, loc),
            lowerer.coerceToExpected(varRef(valueLocal.id, valueT, loc), DYN),
            lowerer.coerceToExpected(dispose, DYN),
          ],
          type: BOOL,
          loc,
        },
        loc,
      },
    ],
    result: varRef(valueLocal.id, valueT, loc),
    type: valueT,
    loc,
  };
}

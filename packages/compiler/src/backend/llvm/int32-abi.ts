import type { IrExpr, IrFunction, IrModule } from "../../ir/ir.js";
import type { Int32Slots } from "../../ir/int32-slots.js";
import { everyStmtList } from "../../ir/traverse.js";

/** The i32 entry of a function: which number parameters it receives as
 * i32, and whether its number result is returned as i32. */
export interface Int32Abi {
  params: readonly boolean[];
  result: boolean;
}

/** Suffix of a function's i32 entry symbol. The ordinary symbol stays a
 * double-ABI wrapper around it. */
export const INT32_ABI_SUFFIX = ".i32";

/** Functions whose direct calls pass int32 parameters and results in
 * integer registers.
 *
 * A parameter qualifies when analyzeInt32Slots proved its incoming value
 * an int32 at every call site (it only does so for functions reached by
 * direct calls alone, never as values, through virtual dispatch or from
 * the runtime) or an Int32 contract pins it. A result qualifies when every
 * return is proven an int32. The proofs exclude -0, NaN and fractions, so
 * the i32 converts back to the same double. A parameter that a number
 * (not i32) result returns as is, like `n` in `n < 2 ? n : fib(n - 1) +
 * fib(n - 2)`, keeps its double: the incoming double is that result, where
 * an i32 would add a conversion to the path that returns it.
 *
 * Only direct `call` and `new` sites use the i32 entry. Every other way to
 * reach the function (closure and virtual-dispatch entries, constructor
 * thunks, adapters, the runtime) keeps the double-ABI symbol, which becomes
 * a thin wrapper that converts and calls the i32 entry. Async functions and
 * generators keep their own entries; library builds (no slot facts) and
 * debug builds (numbers stay doubles for the debugger) select none. */
export function findInt32Abis(mod: IrModule, slots: Int32Slots): Map<string, Int32Abi> {
  const result = new Map<string, Int32Abi>();
  for (const fn of mod.functions) {
    if (fn.async || fn.generator || fn.captures !== undefined || !slots.called.has(fn.name))
      continue;
    const ret = fn.returnType.kind === "f64" && slots.hasReturn(fn.name);
    let params = fn.params.map(
      (param) => param.type.kind === "f64" && slots.hasParam(fn.name, param.localId),
    );
    if (!ret && params.includes(true)) {
      const returned = returnedLocals(fn);
      params = params.map((i32, index) => i32 && !returned.has(fn.params[index]!.localId));
    }
    if (ret || params.includes(true)) result.set(fn.name, { params, result: ret });
  }
  return result;
}

/** Locals some `return` hands back as its value (directly or as an arm of
 * a conditional). */
function returnedLocals(fn: IrFunction): Set<string> {
  const result = new Set<string>();
  const value = (e: IrExpr): void => {
    if (e.kind === "varRef") result.add(e.localId);
    else if (e.kind === "ternary") {
      value(e.then);
      value(e.else_);
    }
  };
  everyStmtList(fn.body, {
    stmt: (s) => {
      if (s.kind === "return" && s.value) value(s.value);
      return true;
    },
    expr: () => true,
  });
  return result;
}

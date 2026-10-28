import type { IrModule } from "../../ir/ir.js";
import type { LlvmTargetOptions } from "./emitter.js";

/** Test helper: emission options that keep every union of `mod` a tagged
 * `%ScrUnion` box, so stack-box tests exercise the paths that
 * nullable-pointer unions (nullable-unions.ts) bypass. */
export function keepUnionsBoxed(mod: IrModule): LlvmTargetOptions {
  return { boxedUnions: new Set((mod.unions ?? []).map((union) => union.id)) };
}

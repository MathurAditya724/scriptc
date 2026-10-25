import type { IrModule, IrType } from "../../ir/ir.js";

/** Test helper: a Set of each union keeps it a tagged `%ScrUnion` box (Set
 * elements are runtime-inspected boxes), so stack-box tests exercise the
 * paths that nullable-pointer unions (nullable-unions.ts) bypass. */
export function keepUnionsBoxed(mod: IrModule): IrModule {
  const keep = (mod.unions ?? []).map((union) => ({
    id: `%g.keep.${union.id}`,
    name: `keep_${union.id}`,
    type: { kind: "set", elem: { kind: "union", unionId: union.id } } as IrType,
    mutable: false,
  }));
  return { ...mod, globals: [...(mod.globals ?? []), ...keep] };
}

import {
  isUnitType,
  type IrClassDef,
  type IrModule,
  type IrType,
  type IrUnionDef,
} from "../../ir/ir.js";
import { everyModuleNode } from "../../ir/traverse.js";

/** A union of exactly one reference arm and one or two unit arms
 * (`C | undefined`, `C | null`, `C | null | undefined`) whose VALUES are
 * the reference pointer itself: NULL is the unit arm (`undefined` when both
 * unit arms exist, where the module's immortal NULLABLE_NULL sentinel is
 * `null`), anything else is the reference arm's instance. No union box
 * ever exists for such a type: wraps move the payload, narrowing borrows
 * it, retain/release/trace are the arm's NULL-tolerant entry points, and
 * every container, field, capture, parameter, and return slot holds the
 * plain pointer. Every other union keeps the tagged `%ScrUnion` box. */
export interface NullableUnion {
  unionId: string;
  refTag: number;
  /** The unit arm NULL encodes. */
  unitTag: number;
  /** The `null` arm of a two-unit-arm union, encoded by NULLABLE_NULL;
   * -1 when the union has one unit arm. */
  nullTag: number;
  arm: NullableRefArm;
}

/** The module-scope immortal sentinel standing for `null` in a
 * `C | null | undefined` union (NULL is `undefined` there). */
export const NULLABLE_NULL = "@sc_nullable_null";

/** The module-scope immortal sentinel standing for the ABSENT state of a
 * nullable union's record field slot (an omitted optional property). */
export const NULLABLE_ABSENT = "@sc_nullable_absent";

/** The reference arms whose instances are never NULL. Class and record
 * entry points all tolerate NULL; strings, Stats snapshots, arrays, maps and
 * sets retain through a NULL-skipping wrapper (shapes.ts). Object arms are
 * always truthy and compare by identity; string arms are truthy when
 * non-empty and compare bytes. */
export type NullableRefArm =
  | { kind: "object"; className: string }
  | { kind: "record"; shapeId: string }
  | { kind: "string" }
  | { kind: "stats" }
  | (IrType & { kind: "array" | "map" | "set" });

/** The arm is a JS object: always truthy, compared by identity. */
export function isObjectArm(nullable: NullableUnion): boolean {
  return nullable.arm.kind !== "string";
}

/** The representation decision for every union of one module. It is a
 * pure function of the module, so serialized-IR and in-memory emission
 * agree. */
export class NullableUnions {
  private readonly byId = new Map<string, NullableUnion>();
  /** NULL-skipping retain wrappers requested so far: symbol → inner retain
   * call target. The emitter defines each once. */
  readonly retainWrappers = new Map<string, string>();
  /** Some nullable union encodes `null` with NULLABLE_NULL. */
  readonly usesNullSentinel: boolean = false;

  constructor(mod: IrModule) {
    const emitted = new Set<string>();
    for (const cls of mod.classes ?? []) if (!cls.runtime) emitted.add(cls.name);
    const records = new Set<string>();
    for (const shape of mod.records ?? []) records.add(shape.id);
    const boxed = boxedUnionIds(mod);
    for (const def of mod.unions ?? []) {
      if (boxed.has(def.id)) continue;
      const nullable = nullableShape(def, emitted, records);
      if (!nullable) continue;
      this.byId.set(def.id, nullable);
      if (nullable.nullTag >= 0) this.usesNullSentinel = true;
    }
  }

  get(unionId: string): NullableUnion | null {
    return this.byId.get(unionId) ?? null;
  }

  of(type: IrType): NullableUnion | null {
    return type.kind === "union" ? this.get(type.unionId) : null;
  }

  has(unionId: string): boolean {
    return this.byId.has(unionId);
  }

  get size(): number {
    return this.byId.size;
  }

  /** The reference arm of every nullable union, by union id. */
  armTypes(): Map<string, IrType> {
    const result = new Map<string, IrType>();
    for (const [id, nullable] of this.byId) result.set(id, nullable.arm);
    return result;
  }

  /** The union table restricted to tagged-box unions: the stack-box
   * optimizations (stack wraps, stack map/array reads, local union storage)
   * only apply to boxes. */
  boxedUnions(unions: ReadonlyMap<string, IrUnionDef>): Map<string, IrUnionDef> {
    const result = new Map<string, IrUnionDef>();
    for (const [id, def] of unions) if (!this.byId.has(id)) result.set(id, def);
    return result;
  }
}

function nullableShape(
  def: IrUnionDef,
  emittedClasses: ReadonlySet<string>,
  records: ReadonlySet<string>,
): NullableUnion | null {
  const units = def.arms.filter(isUnitType).length;
  if (units < 1 || units > 2 || def.arms.length !== units + 1) return null;
  const refTag = def.arms.findIndex((arm) => !isUnitType(arm));
  let unitTag: number, nullTag: number;
  if (units === 1) {
    unitTag = def.arms.findIndex(isUnitType);
    nullTag = -1;
  } else {
    unitTag = def.arms.findIndex((arm) => arm.kind === "undefinedT");
    nullTag = def.arms.findIndex((arm) => arm.kind === "nullT");
    if (unitTag < 0 || nullTag < 0) return null;
  }
  const arm = def.arms[refTag]!;
  const base = { unionId: def.id, refTag, unitTag, nullTag };
  if (arm.kind === "object" && emittedClasses.has(arm.className))
    return { ...base, arm: { kind: "object", className: arm.className } };
  if (arm.kind === "record" && records.has(arm.shapeId))
    return { ...base, arm: { kind: "record", shapeId: arm.shapeId } };
  if (arm.kind === "string") return { ...base, arm: { kind: "string" } };
  if (arm.kind === "stats") return { ...base, arm: { kind: "stats" } };
  if (arm.kind === "array" || arm.kind === "map" || arm.kind === "set") return { ...base, arm };
  return null;
}

/** Unions the runtime itself inspects as tagged boxes keep that
 * representation: Map keys and Set elements hash and compare union keys by
 * tag and payload inside the C map. */
function boxedUnionIds(mod: IrModule): Set<string> {
  const boxed = new Set<string>();
  const mark = (t: IrType): void => {
    if (t.kind === "union") boxed.add(t.unionId);
  };
  everyModuleNode(mod, {
    expr: () => true,
    stmt: () => true,
    type: (t) => {
      if (t.kind === "map") mark(t.key);
      else if (t.kind === "set") mark(t.elem);
      return true;
    },
  });
  return boxed;
}

/** Emitted classes keyed by name, for callers that only hold the class
 * list (nullable class fields). */
export function emittedClassNames(classes: readonly IrClassDef[]): Set<string> {
  const names = new Set<string>();
  for (const cls of classes) if (!cls.runtime) names.add(cls.name);
  return names;
}

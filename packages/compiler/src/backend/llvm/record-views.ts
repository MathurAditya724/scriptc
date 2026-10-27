/* Record views: one object across record layouts (decision D3).
 *
 * A checked conversion of a capsule of a native record A into another
 * record type B whose fields A also has (same names and types, any
 * offsets) answers a view: a B-shaped object whose fields live in A. The
 * view's storage is B's struct plus two trailing words, the A record
 * (borrowed: the view's record-source entry owns A's capsule, which owns
 * A) and a table of A's byte offsets for B's fields. Every field address
 * of a B value tests the first word (recordViewFieldPtr), so reads and
 * writes through either name reach the same storage, and boxing a view
 * answers A's capsule (scr_dyn_record_view), so identity holds too.
 *
 * Only the target types of such conversions carry the words and the
 * test. They are found from the IR, before any code is emitted: B is a
 * record type a checked conversion can produce (the closure of dynCheck
 * targets and of the types live capsules expose) and some other record
 * type in the module has all of B's fields. A program without checked
 * conversions has none, so its code is unchanged. */
import {
  isDirentShape,
  KEY_ORDER_FIELD,
  shapeHasAccessorSlots,
  shapeKeyOrders,
  typeKey,
  type IrModule,
  type IrRecordShape,
  type IrType,
} from "../../ir/ir.js";
import { everyStmtList } from "../../ir/traverse.js";
import type { BlockBuilder } from "./blocks.js";

export interface RecordViews {
  /** Shape ids whose values may be views. */
  readonly targets: ReadonlySet<string>;
  /** The record shapes whose capsules convert to a view of `target`. */
  sources(target: string): readonly string[];
}

export const NO_RECORD_VIEWS: RecordViews = { targets: new Set(), sources: () => [] };

interface ViewOptions {
  readonly traced: (shapeId: string) => boolean;
  readonly excluded: (shapeId: string) => boolean;
}

function plainShape(shape: IrRecordShape): boolean {
  return (
    !shape.tuple &&
    !shape.indexValue &&
    shape.fields.length > 0 &&
    !isDirentShape(shape) &&
    !shapeHasAccessorSlots(shape) &&
    shapeKeyOrders(shape).length === 1 &&
    !shape.fields.some((field) => field.name === KEY_ORDER_FIELD || field.name.startsWith("%"))
  );
}

/** Whether every field of `target` is a field of `source` with the same
 * type (the view reads A's field with B's representation). */
function covers(source: IrRecordShape, target: IrRecordShape): boolean {
  const fields = new Map(source.fields.map((field) => [field.name, typeKey(field.type)]));
  return target.fields.every((field) => fields.get(field.name) === typeKey(field.type));
}

export function planRecordViews(mod: IrModule, options: ViewOptions): RecordViews {
  const shapes = new Map((mod.records ?? []).map((shape) => [shape.id, shape]));
  const unions = new Map((mod.unions ?? []).map((union) => [union.id, union]));
  const reachable = new Set<string>();
  const seen = new Set<string>();
  const visit = (t: IrType): void => {
    const key = typeKey(t);
    if (seen.has(key)) return;
    seen.add(key);
    switch (t.kind) {
      case "record": {
        reachable.add(t.shapeId);
        for (const field of shapes.get(t.shapeId)?.fields ?? []) visit(field.type);
        return;
      }
      case "array":
        visit(t.elem);
        return;
      case "union":
        for (const arm of unions.get(t.unionId)?.arms ?? []) visit(arm);
        return;
      default:
        return;
    }
  };
  for (const fn of mod.functions)
    everyStmtList(fn.body, {
      stmt: () => true,
      expr: (e) => {
        if (e.kind === "dynCheck") visit(e.type);
        else if (e.kind === "dynFrom" && e.liveRef === true) visit(e.value.type);
        return true;
      },
    });
  if (reachable.size === 0) return NO_RECORD_VIEWS;
  const targets = new Set<string>();
  const sources = new Map<string, string[]>();
  for (const id of reachable) {
    const target = shapes.get(id);
    if (!target || !plainShape(target) || target.freezable === true) continue;
    if (options.traced(id) || options.excluded(id)) continue;
    const found: string[] = [];
    for (const source of shapes.values()) {
      if (source.id === id || !reachable.has(source.id) || !plainShape(source)) continue;
      if (covers(source, target)) found.push(source.id);
    }
    if (found.length === 0) continue;
    targets.add(id);
    sources.set(id, found);
  }
  if (targets.size === 0) return NO_RECORD_VIEWS;
  return { targets, sources: (target) => sources.get(target) ?? [] };
}

/** The struct indices of a view target's two trailing words. */
export function recordViewWords(
  fieldCount: number,
  base: number,
): { record: number; offsets: number } {
  return { record: fieldCount + base, offsets: fieldCount + base + 1 };
}

/** The address of field `position` (declaration index) of the record
 * `obj` of view-target shape `struct`: the slot itself, or the source
 * record's slot when `obj` is a view. Leaves `B` in a fresh block. */
export function recordViewFieldPtr(
  B: BlockBuilder,
  sizeType: "i32" | "i64",
  struct: string,
  obj: string,
  slotIndex: number,
  position: number,
  words: { record: number; offsets: number },
): string {
  const own = B.tmp();
  B.line(`${own} = getelementptr inbounds %${struct}, ptr ${obj}, i64 0, i32 ${slotIndex}`);
  const recordPtr = B.tmp();
  const record = B.tmp();
  const isView = B.tmp();
  B.line(
    `${recordPtr} = getelementptr inbounds %${struct}, ptr ${obj}, i64 0, i32 ${words.record}`,
  );
  B.line(`${record} = load ptr, ptr ${recordPtr}`);
  B.line(`${isView} = icmp ne ptr ${record}, null`);
  const from = B.currentLabel();
  const view = B.newLabel("rv.view");
  const join = B.newLabel("rv.join");
  B.condBr(isView, view, join);
  B.startBlock(view);
  const tablePtr = B.tmp();
  const table = B.tmp();
  const offsetPtr = B.tmp();
  const offset = B.tmp();
  const viewed = B.tmp();
  B.line(
    `${tablePtr} = getelementptr inbounds %${struct}, ptr ${obj}, i64 0, i32 ${words.offsets}`,
  );
  B.line(`${table} = load ptr, ptr ${tablePtr}`);
  B.line(`${offsetPtr} = getelementptr inbounds ${sizeType}, ptr ${table}, i64 ${position}`);
  B.line(`${offset} = load ${sizeType}, ptr ${offsetPtr}`);
  B.line(`${viewed} = getelementptr inbounds i8, ptr ${record}, ${sizeType} ${offset}`);
  B.br(join);
  B.startBlock(join);
  const ptr = B.tmp();
  B.line(`${ptr} = phi ptr [ ${own}, %${from} ], [ ${viewed}, %${view} ]`);
  return ptr;
}

/* Record views: one object across record layouts (decision D3).
 *
 * A checked conversion of a capsule of a native record A into another
 * record type B whose fields A also has (same names and types, any
 * offsets) answers a view: a B-shaped object whose fields live in A. The
 * view's storage is B's struct plus two trailing words, the A record
 * (borrowed: the view's record-source entry owns A's capsule, which owns
 * A) and a table of A's byte offsets for B's fields, and its rc word
 * carries the frozen bit as the view mark. Every field address of a B
 * value tests the mark (recordViewFieldPtr), so reads and
 * writes through either name reach the same storage, and boxing a view
 * answers A's capsule (scr_dyn_record_view), so identity holds too.
 *
 * Only the target types of such conversions carry the words and the
 * test. They are found from the IR, before any code is emitted: B is a
 * record type a checked conversion can produce (the closure of dynCheck
 * targets), and some other record type whose values reach untyped code as
 * live capsules (the closure of live dynFrom types) has all of B's fields. A program without checked
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
  // Targets: record types a checked conversion produces. Sources: record
  // types whose values reach untyped code as live capsules. A view arises
  // only where the two meet; elsewhere a conversion keeps its copy.
  const closure = (roots: IrType[]): Set<string> => {
    const out = new Set<string>();
    const seen = new Set<string>();
    const visit = (t: IrType): void => {
      const key = typeKey(t);
      if (seen.has(key)) return;
      seen.add(key);
      switch (t.kind) {
        case "record": {
          out.add(t.shapeId);
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
    for (const root of roots) visit(root);
    return out;
  };
  const checked: IrType[] = [];
  const boxed: IrType[] = [];
  for (const fn of mod.functions)
    everyStmtList(fn.body, {
      stmt: () => true,
      expr: (e) => {
        if (e.kind === "dynCheck") checked.push(e.type);
        else if (e.kind === "dynFrom" && e.liveRef === true) boxed.push(e.value.type);
        return true;
      },
    });
  if (checked.length === 0 || boxed.length === 0) return NO_RECORD_VIEWS;
  const reachable = closure(checked);
  const live = closure(boxed);
  if (reachable.size === 0) return NO_RECORD_VIEWS;
  const targets = new Set<string>();
  const sources = new Map<string, string[]>();
  for (const id of reachable) {
    const target = shapes.get(id);
    if (!target || !plainShape(target) || target.freezable === true) continue;
    if (options.traced(id) || options.excluded(id)) continue;
    const found: string[] = [];
    for (const source of shapes.values()) {
      if (source.id === id || !live.has(source.id) || !plainShape(source)) continue;
      if (covers(source, target)) found.push(source.id);
    }
    if (found.length === 0) continue;
    targets.add(id);
    sources.set(id, found);
  }
  if (targets.size === 0) return NO_RECORD_VIEWS;
  return { targets, sources: (target) => sources.get(target) ?? [] };
}

/** Lines setting `dest` (i1) to whether the record `obj` of a view target
 * type is a view. A view's rc word carries the frozen bit (scr_rc.h
 * SCR_RC_FROZEN), which no other value of such a type has: view targets
 * are never freezable, and a word with the program-lifetime bit (an
 * immortal one included) is no view, so a view's word is the frozen bit
 * plus a count. The
 * trailing words are read only after this test, so a value of another
 * storage seen through the type is never read past its end. */
export function recordViewTestLines(sizeType: "i32" | "i64", obj: string, dest: string): string[] {
  // The frozen bit with a count and no program-lifetime bit: one range.
  const [bit, span] =
    sizeType === "i64" ? ["4611686018427387904", "4294967296"] : ["1073741824", "1073741824"];
  return [
    `  ${dest}.w = load ${sizeType}, ptr ${obj}`,
    `  ${dest}.d = sub ${sizeType} ${dest}.w, ${bit}`,
    `  ${dest} = icmp ult ${sizeType} ${dest}.d, ${span}`,
  ];
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
  declare: (decl: string) => void,
  outOfLine: boolean,
): string {
  const own = B.tmp();
  B.line(`${own} = getelementptr inbounds %${struct}, ptr ${obj}, i64 0, i32 ${slotIndex}`);
  const wordsOffset = `${sizeType} ptrtoint (ptr getelementptr (%${struct}, ptr null, i32 0, i32 ${words.record}) to ${sizeType})`;
  if (outOfLine) {
    // Unoptimized builds give every value a frame slot: one call keeps
    // the guard to a single value per access.
    declare(`declare ptr @scr_record_view_field(ptr, ptr, ${sizeType}, ${sizeType})`);
    const ptr = B.tmp();
    B.line(
      `${ptr} = call ptr @scr_record_view_field(ptr ${obj}, ptr ${own}, ${wordsOffset}, ${sizeType} ${position})`,
    );
    return ptr;
  }
  const isView = B.tmp();
  for (const line of recordViewTestLines(sizeType, obj, isView)) B.line(line.trimStart());
  const from = B.currentLabel();
  const view = B.newLabel("rv.view");
  const join = B.newLabel("rv.join");
  // Views are rare: the slot lookup stays out of line.
  B.condBr(isView, view, join, `, !prof !{!"branch_weights", i32 1, i32 1000}`);
  B.startBlock(view);
  declare(`declare ptr @scr_record_view_slot(ptr, ${sizeType}, ${sizeType})`);
  const viewed = B.tmp();
  B.line(
    `${viewed} = call ptr @scr_record_view_slot(ptr ${obj}, ${wordsOffset}, ${sizeType} ${position})`,
  );
  B.br(join);
  B.startBlock(join);
  const ptr = B.tmp();
  B.line(`${ptr} = phi ptr [ ${own}, %${from} ], [ ${viewed}, %${view} ]`);
  return ptr;
}

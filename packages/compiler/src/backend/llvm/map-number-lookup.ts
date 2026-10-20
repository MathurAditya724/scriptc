/* Inline number-key Map/Set reads.
 *
 * Number-keyed collections whose keys are small non-negative integers keep a
 * direct index in the runtime (scr_map.c). Reads go through the internal
 * sc_map_entry_f64 helper (emitter.ts helperDefs), which LLVM inlines: it
 * resolves directly indexed maps without a call and other maps through
 * the internal sc_map_entry_f64_hashed probe, which hashes the key as the
 * runtime does and defers to scr_map_entry_f64 only for wide bucket
 * tables. Both only read memory. The generated code then reads the entry's
 * value slot itself and retains a reference value with the value type's own
 * retain, which is the adapter the collection was constructed with.
 * String-keyed reads use the same entry contract through the internal
 * sc_map_entry_str helper, which rejects keys outside the map's absent-key
 * filter inline and defers to scr_map_entry_str otherwise: reference reads
 * retain inline rather than through the runtime's indirect adapter call,
 * and scalar reads and has() share the one lookup.
 *
 * The iteration steps behind for-of, forEach and the other entry walks read
 * the entries array through the internal sc_map_iter_entry and
 * sc_map_iter_count helpers: a live entry's key or value loads in place,
 * and the runtime accessor runs only for an index the walk's liveness
 * guard excludes. for-of starts at scr_map_iter_start, past a deleted
 * prefix.
 */
import type { IrType } from "../../ir/ir.js";
import type { LlvmEmitterContext } from "./expr-context.js";

export const NUMBER_MAP_ENTRY_DECL = "declare ptr @scr_map_entry_f64(ptr, double)";

/** The entry for `key`, or null when absent. Valid until the next mutation. */
export function emitNumberMapEntry(host: LlvmEmitterContext, map: string, key: string): string {
  host.declare(NUMBER_MAP_ENTRY_DECL);
  const entry = host.B.tmp();
  host.B.line(`${entry} = call ptr @sc_map_entry_f64(ptr ${map}, double ${key})`);
  return entry;
}

/** Load a found entry's value slot as `type` (double, i64 or ptr). */
export function emitNumberMapSlot(host: LlvmEmitterContext, entry: string, type: string): string {
  const B = host.B;
  const slot = B.tmp(),
    value = B.tmp();
  B.line(`${slot} = getelementptr inbounds %ScrMapEntry, ptr ${entry}, i32 0, i32 1`);
  B.line(`${value} = load ${type}, ptr ${slot}`);
  return value;
}

export const STRING_MAP_ENTRY_DECL = "declare ptr @scr_map_entry_str(ptr, ptr)";

/** The entry for a string `key`, or null when absent. Valid until the next mutation. */
export function emitStringMapEntry(host: LlvmEmitterContext, map: string, key: string): string {
  host.declare(STRING_MAP_ENTRY_DECL);
  const entry = host.B.tmp();
  host.B.line(`${entry} = call ptr @sc_map_entry_str(ptr ${map}, ptr ${key})`);
  return entry;
}

/** Map.has / Set.has under a string key. */
export function emitStringMapHas(host: LlvmEmitterContext, map: string, key: string): string {
  const entry = emitStringMapEntry(host, map, key);
  const found = host.B.tmp();
  host.B.line(`${found} = icmp ne ptr ${entry}, null`);
  return found;
}

/** Map.get of a scalar value under a string key; see emitNumberMapGetScalar. */
export function emitStringMapGetScalar(
  host: LlvmEmitterContext,
  map: string,
  key: string,
): { found: string; bits: string; entry: string } {
  return emitMapEntryGetScalar(host, emitStringMapEntry(host, map, key));
}

/** Map.get of a reference value: a +1 value, or null when absent — the
 * contract of scr_map_get_f64_ref. */
export function emitNumberMapGetRef(
  host: LlvmEmitterContext,
  map: string,
  key: string,
  value: IrType,
): string {
  return emitMapEntryGetRef(host, emitNumberMapEntry(host, map, key), value);
}

/** Map.get of a reference value under a string key, with scr_map_get_str_ref's
 * contract. The value type's own retain replaces the collection's adapter, so
 * the retain is inline instead of an indirect call in the runtime. */
export function emitStringMapGetRef(
  host: LlvmEmitterContext,
  map: string,
  key: string,
  value: IrType,
): string {
  return emitMapEntryGetRef(host, emitStringMapEntry(host, map, key), value);
}

/** The +1 value of a found entry, or null for a missing (null) entry. */
function emitMapEntryGetRef(host: LlvmEmitterContext, entry: string, value: IrType): string {
  const B = host.B;
  const found = B.tmp();
  B.line(`${found} = icmp ne ptr ${entry}, null`);
  const hit = B.newLabel("mapn.hit"),
    miss = B.newLabel("mapn.miss"),
    join = B.newLabel("mapn.join");
  B.condBr(found, hit, miss);
  B.startBlock(hit);
  const retained = host.retainFrame(emitNumberMapSlot(host, entry, "ptr"), value);
  B.br(join);
  B.startBlock(miss);
  B.br(join);
  B.startBlock(join);
  const result = B.tmp();
  B.line(`${result} = phi ptr [ ${retained}, %${hit} ], [ null, %${miss} ]`);
  return result;
}

/** Map.get of a scalar value: the found flag, and the raw 64-bit slot
 * (zero when absent). Booleans are stored as 0/1. */
export function emitNumberMapGetScalar(
  host: LlvmEmitterContext,
  map: string,
  key: string,
): { found: string; bits: string; entry: string } {
  return emitMapEntryGetScalar(host, emitNumberMapEntry(host, map, key));
}

/** The found flag and raw 64-bit slot (zero when absent) of an entry. */
function emitMapEntryGetScalar(
  host: LlvmEmitterContext,
  entry: string,
): { found: string; bits: string; entry: string } {
  const B = host.B;
  const found = B.tmp();
  B.line(`${found} = icmp ne ptr ${entry}, null`);
  const hit = B.newLabel("mapn.hit"),
    miss = B.newLabel("mapn.miss"),
    join = B.newLabel("mapn.join");
  B.condBr(found, hit, miss);
  B.startBlock(hit);
  const loaded = emitNumberMapSlot(host, entry, "i64");
  B.br(join);
  B.startBlock(miss);
  B.br(join);
  B.startBlock(join);
  const bits = B.tmp();
  B.line(`${bits} = phi i64 [ ${loaded}, %${hit} ], [ 0, %${miss} ]`);
  return { found, bits, entry };
}

/** Map.has / Set.has. */
export function emitNumberMapHas(host: LlvmEmitterContext, map: string, key: string): string {
  const entry = emitNumberMapEntry(host, map, key);
  const found = host.B.tmp();
  host.B.line(`${found} = icmp ne ptr ${entry}, null`);
  return found;
}

/** Map.set / Set.add of a scalar value under a number key: a found entry
 * takes the value in its slot (a Set entry's unit value is already there);
 * a new key appends through `append`, the runtime set. */
export function emitNumberMapSetScalar(
  host: LlvmEmitterContext,
  map: string,
  key: string,
  bits: string | null,
  append: () => void,
): void {
  const B = host.B;
  const entry = emitNumberMapEntry(host, map, key);
  const found = B.tmp();
  B.line(`${found} = icmp ne ptr ${entry}, null`);
  const hit = B.newLabel("mapn.set.hit"),
    miss = B.newLabel("mapn.set.miss"),
    join = B.newLabel("mapn.set.join");
  B.condBr(found, hit, miss);
  B.startBlock(hit);
  if (bits !== null) {
    const slot = B.tmp();
    B.line(`${slot} = getelementptr inbounds %ScrMapEntry, ptr ${entry}, i32 0, i32 1`);
    B.line(`store i64 ${bits}, ptr ${slot}`);
  }
  B.br(join);
  B.startBlock(miss);
  append();
  B.br(join);
  B.startBlock(join);
}

/** Declared by the inline Map/Set iteration steps; its presence makes the
 * emitter define sc_map_iter_entry and sc_map_iter_count (emitter.ts). */
export const MAP_ITER_DECL = "declare zeroext i1 @scr_map_iter_live(ptr, double)";

/** The entry at an iteration index, or null for a tombstone or an index at
 * or past the entry count (the scr_map_iter_live test). */
export function emitMapIterEntry(host: LlvmEmitterContext, map: string, index: string): string {
  host.declare(MAP_ITER_DECL);
  const entry = host.B.tmp();
  host.B.line(`${entry} = call ptr @sc_map_iter_entry(ptr ${map}, double ${index})`);
  return entry;
}

/** The first live index (scr_map_iter_start), where for-of starts: the
 * runtime walks the deleted prefix once and remembers where it ends. */
export function emitMapIterStart(host: LlvmEmitterContext, map: string): string {
  host.declare("declare double @scr_map_iter_start(ptr)");
  const start = host.B.tmp();
  host.B.line(`${start} = call double @scr_map_iter_start(ptr ${map})`);
  return start;
}

/** The entry count, tombstones included (scr_map_iter_count). */
export function emitMapIterCount(host: LlvmEmitterContext, map: string): string {
  host.declare(MAP_ITER_DECL);
  const count = host.B.tmp();
  host.B.line(`${count} = call double @sc_map_iter_count(ptr ${map})`);
  return count;
}

/** The key (field 0) or value (field 1) of the live entry at an iteration
 * index, read inline: a number as double, a boolean as i1, and a string or
 * reference retained with `type`'s retain (+1), the adapter the collection
 * stores it with. An index that is not live calls `runtime`, the runtime
 * accessor, which reports the internal error the iteration guard rules out. */
export function emitMapIterSlot(
  host: LlvmEmitterContext,
  map: string,
  index: string,
  field: 0 | 1,
  access: "f64" | "bool" | "ref",
  type: IrType,
  runtime: { decl: string; symbol: string },
  /** An i1 that must also hold for the inline read; otherwise a live entry
   * reads through `runtime` too. */
  inline?: string,
): string {
  const B = host.B;
  const entry = emitMapIterEntry(host, map, index);
  let found = B.tmp();
  B.line(`${found} = icmp ne ptr ${entry}, null`);
  if (inline !== undefined) {
    const both = B.tmp();
    B.line(`${both} = and i1 ${found}, ${inline}`);
    found = both;
  }
  const hit = B.newLabel("mapit.hit"),
    miss = B.newLabel("mapit.miss"),
    join = B.newLabel("mapit.join");
  B.condBr(found, hit, miss);
  B.startBlock(hit);
  const slot = B.tmp();
  B.line(`${slot} = getelementptr inbounds %ScrMapEntry, ptr ${entry}, i32 0, i32 ${field}`);
  const llTy = access === "f64" ? "double" : access === "bool" ? "i1" : "ptr";
  let loaded = B.tmp();
  if (access === "bool") {
    const bits = loaded;
    B.line(`${bits} = load i64, ptr ${slot}`);
    loaded = B.tmp();
    B.line(`${loaded} = icmp ne i64 ${bits}, 0`);
  } else {
    B.line(`${loaded} = load ${llTy}, ptr ${slot}`);
    if (access === "ref") loaded = host.retainFrame(loaded, type);
  }
  const hitEnd = B.currentLabel();
  B.br(join);
  B.startBlock(miss);
  host.declare(runtime.decl);
  const fallback = B.tmp();
  B.line(`${fallback} = call ${llTy} @${runtime.symbol}(ptr ${map}, double ${index})`);
  B.br(join);
  B.startBlock(join);
  const result = B.tmp();
  B.line(`${result} = phi ${llTy} [ ${loaded}, %${hitEnd} ], [ ${fallback}, %${miss} ]`);
  return result;
}

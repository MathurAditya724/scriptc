"use native";
/* Struct interfaces, fixed arrays, declared globals and thread-locals, an
 * alias over them, and target folding, for the native-unit tests. */
import {
  Size,
  type CStruct,
  type Extern,
  type FixedArray,
  type Inline,
  type Pointer,
  type ThreadLocal,
  type Uint8,
  type Uint32,
  target,
} from "@scriptc/experimental/native";

export interface Node extends CStruct<"Node"> {
  next: Node | null;
  tag: Uint8;
  size: Size;
}

export interface Table extends CStruct<"Table"> {
  count: Uint32;
  heads: FixedArray<Node | null, 8>;
  cursor: Pointer<Uint8>;
}

export interface Hot extends CStruct<"Hot"> {
  table: Inline<Table>;
  hits: Size;
}

declare const table: Extern<Table, "native_table">;
declare const hot: ThreadLocal<Hot>;
declare function onMain(): void;
declare function onWorkers(): void;

/** The table this build counts in, like a C macro over a build flag. */
const current = target.workers ? hot.table : table;

export function sizeOf(n: Node): Size {
  return n.size;
}

export function push(n: Node, i: Size): void {
  n.next = table.heads.get(i);
  table.heads.set(i, n);
  table.count += 1n;
}

export function threadHits(): Size {
  hot.hits += 1n;
  return hot.hits;
}

export function branch(): void {
  if (target.workers) onWorkers();
  else onMain();
}

export function currentCount(): Uint32 {
  return current.count;
}

export function pointerBytes(): Size {
  return target.pointerBytes === 8n ? 8n : 4n;
}

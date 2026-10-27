/* Per-unit records of reachable-emit lowering (Lowerer.emitReachable).
 *
 * A unit's record is what another process needs to reach the state the
 * unit's lowering reached: the unit's IR, the entries it added to the
 * tables that collect lowering results (Lowerer.journalTables), and the
 * calls it made into reachability, generic demand and statement counting
 * (JournalEvent). Records hold only strings, numbers and names, so they can
 * be written to a file and read by another process or another build.
 *
 * A unit has no record when its lowering changed state that no record
 * carries: a table that is not appendable grew, a field changed, an entry
 * held before the unit was replaced, or a diagnostic was emitted. Such a
 * unit lowers again wherever its record would have been applied.
 *
 * SCRIPTC_LOWER_JOURNAL=serial records every unit while it lowers, and
 * replaces the unit's results with the ones its record carries: the
 * function decoded from the record and the table entries added again from
 * it. The build's output is then the output of applying the records, which
 * tests compare with ordinary lowering. SCRIPTC_LOWER_JOURNAL_DUMP=<dir>
 * turns the serial mode on and appends each unit's record to
 * <dir>/records.jsonl, one JSON line per unit in lowering order; a unit
 * without a record has a line with its name and reasons. */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { InternalCompilerError } from "../../errors.js";
import type { IrFunction } from "../../ir/ir.js";
import { deserializeFunction, encodeFunction } from "../../ir/serialize.js";

/** A function as records hold it, or null when it does not encode. Every
 * function a record holds goes through this pair. */
export function encodeUnitFunction(fn: IrFunction): string | null {
  return encodeFunction(fn) ?? null;
}

/** A function from its record encoding (encodeUnitFunction). */
export function decodeUnitFunction(text: string): IrFunction {
  return deserializeFunction(text);
}

/** A call a unit made while it lowered, which applying its record makes
 * again. */
export interface JournalEvent {
  readonly kind:
    | "edge"
    | "superConstructorEdge"
    | "virtualEdge"
    | "functionDemand"
    | "classDemand"
    | "statement"
    | "failedStatement"
    | "flag";
  /** The edge's body name, the class of a virtual edge or class demand, the
   * generic instance's name, a counted statement's source file, or the
   * flag's field. */
  readonly name: string;
  /** The virtual edge's method, or the file a statement counts toward. */
  readonly detail: string | null;
  /** A counted statement's node index in its source file. */
  readonly index: number;
}

/** One unit's record. */
export interface UnitRecord {
  readonly name: string;
  /** The unit's function in the compact IR encoding, or null when the unit
   * lowered to nothing. */
  readonly fn: string | null;
  /** True when the unit's lowering ended in a poison: its diagnostics and
   * the edges it fired before poisoning stay, and it has no function. */
  readonly poisoned: boolean;
  readonly events: readonly JournalEvent[];
  /** The encoded entries the unit added, by table name, for the tables it
   * grew. */
  readonly tables: Readonly<Record<string, readonly string[]>>;
}

/** A table a unit's lowering can grow. An appendable table only adds
 * entries at the end (Map and Set insertion order, array pushes), so a
 * unit's additions are the entries past the size the table had when the
 * unit started. A checked table has only `size`: when it grows, the unit
 * has no record. */
export interface JournalTable {
  readonly name: string;
  size(): number;
  /** The encoded entries from position `from` on, or null when one of
   * them does not encode. */
  readonly entries?: (from: number) => string[] | null;
  /** Adds the encoded entries whose keys this process's table lacks. */
  readonly apply?: (entries: readonly string[]) => void;
  /** Removes the entries from position `from` on. */
  readonly truncate?: (from: number) => void;
  /** The entries the table holds now. */
  readonly hold?: () => HeldEntries;
  /** The content of the entries the table holds now, for tables whose
   * values are objects a unit could change in place. */
  readonly contents?: () => HeldContents;
}

/** The content of a table's entries at one point (JournalTable.contents). */
export interface HeldContents {
  /** Adds the content of the entries past the ones this holds. */
  extend(): void;
  /** The key of an entry this holds whose content has changed, or null. */
  changed(): string | null;
}

/** A table's entries at one point (JournalTable.hold). */
export interface HeldEntries {
  /** Whether the table's first entries are still these keys and values. */
  same(): boolean;
}

/** A field a unit's lowering must leave as it found it (fixedScalar), or a
 * flag it may set, which applying its record sets too (flagScalar). */
export interface JournalScalar {
  readonly name: string;
  /** Takes the field's value; the result answers how the field changed. */
  mark(): ScalarMark;
  readonly set?: () => void;
}

/** A field's value when a unit started. */
export interface ScalarMark {
  /** Not at all, set (a flag that went from false to true), or otherwise. */
  change(): "same" | "set" | "changed";
}

/** A field a unit's lowering must leave as it found it. */
export function fixedScalar<T>(name: string, get: () => T): JournalScalar {
  return {
    name,
    mark: () => {
      const start = get();
      return { change: () => (get() === start ? "same" : "changed") };
    },
  };
}

/** A flag a unit's lowering may set. */
export function flagScalar(name: string, get: () => boolean, set: () => void): JournalScalar {
  return {
    name,
    mark: () => {
      const start = get();
      return {
        change: () => {
          const now = get();
          return now === start ? "same" : now && !start ? "set" : "changed";
        },
      };
    },
    set,
  };
}

/** The events of the unit being recorded (Lowerer.unitEvents). */
export class UnitEvents {
  readonly events: JournalEvent[] = [];
  /** Calls into reachability nest (an edge can fire virtual edges). Only
   * the outermost call is recorded, because making it again makes the
   * nested ones. */
  depth = 0;

  record(kind: JournalEvent["kind"], name: string, detail: string | null = null, index = 0): void {
    if (this.depth === 0) this.events.push({ kind, name, detail, index });
  }
}

/** The lowerer's side of a recorded wave (Lowerer.emitReachable). */
export interface WaveHost {
  readonly tables: readonly JournalTable[];
  readonly scalars: readonly JournalScalar[];
  /** Lowers `name` as reachable emit does, with `events` recording: the
   * function, or null, and whether the unit poisoned. Throws what lowering
   * throws other than a poison. */
  lowerRecorded(name: string, events: UnitEvents): { fn: IrFunction | null; poisoned: boolean };
  /** Keeps a unit's function. */
  store(name: string, fn: IrFunction | null): void;
  /** Statement totals, and the count of diagnostics and skipped functions. */
  statementCounts(): { total: number; failed: number; other: number };
  /** Whether `event` names something this process holds. */
  resolves(event: JournalEvent): boolean;
}

/** Whether reachable emit records its units (SCRIPTC_LOWER_JOURNAL=serial,
 * or a SCRIPTC_LOWER_JOURNAL_DUMP directory). */
export function journalMode(): "serial" | "off" {
  return process.env["SCRIPTC_LOWER_JOURNAL"] === "serial" || journalDump() !== null
    ? "serial"
    : "off";
}

/** The directory recorded waves write their records to
 * (SCRIPTC_LOWER_JOURNAL_DUMP), or null. */
export function journalDump(): string | null {
  const dir = process.env["SCRIPTC_LOWER_JOURNAL_DUMP"];
  return dir === undefined || dir === "" ? null : dir;
}

/** Appends `lines` to `dir`/records.jsonl. */
export function writeRecords(dir: string, lines: readonly string[]): void {
  if (lines.length === 0) return;
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, "records.jsonl"), `${lines.join("\n")}\n`);
}

/** What a build's recorded waves did (SCRIPTC_TIMING). */
export interface WaveStats {
  waves: number;
  units: number;
  /** Units whose record stands for them. */
  recorded: number;
  /** Units without a record. */
  unrecorded: number;
  /** Per table, field or check, the units it left without a record. */
  reasons: Record<string, number>;
}

export function waveStats(): WaveStats {
  return { waves: 0, units: 0, recorded: 0, unrecorded: 0, reasons: {} };
}

/** What lowering one unit with its events recording produced. */
export interface RecordedUnit {
  /** The unit's record, or null when the unit has none. */
  readonly record: UnitRecord | null;
  /** Why the unit has no record. */
  readonly reasons: readonly string[];
  /** The function lowering made. */
  readonly fn: IrFunction | null;
  /** Each table's size before the unit. */
  readonly before: readonly number[];
}

/** Lowers `name` with its events recording, and makes its record. The unit
 * has a record when every table that grew is appendable and holds the
 * entries it held before, every field is as it was or a flag that was set,
 * statement totals grew by the recorded statements alone, no diagnostic was
 * emitted, every event resolves and the function encodes. */
export function recordUnit(host: WaveHost, name: string): RecordedUnit {
  const tables = host.tables;
  const before = tables.map((table) => table.size());
  const held = tables.map((table) => (table.hold === undefined ? null : table.hold()));
  const marks = host.scalars.map((scalar) => scalar.mark());
  const counts = host.statementCounts();
  const recorder = new UnitEvents();
  const { fn, poisoned } = host.lowerRecorded(name, recorder);
  const reasons: string[] = [];
  const grown: number[] = [];
  tables.forEach((table, index) => {
    const check = held[index] ?? null;
    if (check !== null && !check.same()) reasons.push(`${table.name}:replaced`);
    if (table.size() === before[index]) return;
    if (table.entries === undefined) reasons.push(table.name);
    else grown.push(index);
  });
  const events = [...recorder.events];
  host.scalars.forEach((scalar, index) => {
    const change = marks[index]!.change();
    if (change === "set") events.push({ kind: "flag", name: scalar.name, detail: null, index: 0 });
    else if (change === "changed") reasons.push(scalar.name);
  });
  let statements = 0;
  let failed = 0;
  for (const event of events) {
    if (event.kind === "statement") statements++;
    else if (event.kind === "failedStatement") failed++;
    if (!host.resolves(event)) reasons.push(`event:${event.kind}`);
  }
  const now = host.statementCounts();
  if (now.total - counts.total !== statements || now.failed - counts.failed !== failed)
    reasons.push("statements");
  if (now.other !== counts.other) reasons.push("diagnostics");
  const text = fn === null ? null : encodeUnitFunction(fn);
  if (fn !== null && text === null) reasons.push("encoding");
  const added: Record<string, readonly string[]> = {};
  if (reasons.length === 0)
    for (const index of grown) {
      const table = tables[index]!;
      const entries = table.entries!(before[index]!);
      if (entries === null) reasons.push(`${table.name}:encoding`);
      else added[table.name] = entries;
    }
  if (reasons.length > 0) return { record: null, reasons, fn, before };
  return { record: { name, fn: text, poisoned, events, tables: added }, reasons, fn, before };
}

/** Lowers `wave` with every unit recorded. A unit with a record keeps the
 * results its record carries: the entries it added are taken out of their
 * tables and added again from the record, and its function is the one
 * decoded from the record. A unit without one keeps what lowering made.
 * Throws an InternalCompilerError when a unit changed the content of an
 * entry a table held when the unit started (JournalTable.contents), which
 * no record carries.
 * `lines`, when given, receives each unit's record as a JSON line. */
export function lowerWaveRecorded(
  host: WaveHost,
  wave: readonly string[],
  stats: WaveStats,
  lines: string[] | null = null,
): void {
  stats.waves++;
  const tables = host.tables;
  // Units keep the content of the entries that tables held when they
  // started: a record carries a unit's new entries, not changes to others.
  const contents = tables.map((table) => (table.contents === undefined ? null : table.contents()));
  for (const name of wave) {
    const unit = recordUnit(host, name);
    for (const held of contents) held?.extend();
    stats.units++;
    const record = unit.record;
    if (record === null) {
      lines?.push(JSON.stringify({ name, reasons: unit.reasons }));
      stats.unrecorded++;
      for (const reason of unit.reasons) stats.reasons[reason] = (stats.reasons[reason] ?? 0) + 1;
      host.store(name, unit.fn);
      continue;
    }
    lines?.push(JSON.stringify(record));
    stats.recorded++;
    tables.forEach((table, index) => {
      const entries = record.tables[table.name];
      if (entries === undefined) return;
      table.truncate!(unit.before[index]!);
      table.apply!(entries);
    });
    host.store(name, record.fn === null ? null : decodeUnitFunction(record.fn));
  }
  tables.forEach((table, index) => {
    const key = contents[index]?.changed() ?? null;
    if (key !== null)
      throw new InternalCompilerError(
        `a unit changed ${table.name} entry ${key} in place, which no unit record carries`,
      );
  });
}

/** An appendable table over a Map from strings to strings, such as helper
 * names by key. */
export function mapTable(name: string, map: Map<string, string>): JournalTable {
  return codecTable(
    name,
    map,
    (value) => JSON.stringify(value),
    (text) => JSON.parse(text) as string,
  );
}

/** An appendable table over a Map from strings to numbers. */
export function countTable(name: string, map: Map<string, number>): JournalTable {
  return codecTable(
    name,
    map,
    (value) => String(value),
    (text) => Number(text),
  );
}

/** An appendable table over a Map from strings to IR data, encoded as
 * JSON. JSON writes a number that is not finite as null, so a value whose
 * encoding holds a null does not encode. */
export function irDataTable<V>(name: string, map: Map<string, V>): JournalTable {
  const encode = (value: V): string | null => {
    const text = JSON.stringify(value);
    return /[:,[]null\b/.test(text) ? null : text;
  };
  return {
    ...codecTable(name, map, encode, (text) => JSON.parse(text) as V),
    contents: () => {
      const keys: string[] = [];
      const texts: (string | null)[] = [];
      const held: HeldContents = {
        extend: () => {
          let index = 0;
          for (const [key, value] of map) {
            if (index++ < keys.length) continue;
            keys.push(key);
            texts.push(encode(value));
          }
        },
        changed: () => {
          for (let index = 0; index < keys.length; index++) {
            const key = keys[index]!;
            const value = map.get(key);
            if (value === undefined || encode(value) !== texts[index]) return key;
          }
          return null;
        },
      };
      held.extend();
      return held;
    },
  };
}

/** An appendable table over a Map from strings to values that `encode`
 * writes, or answers null for, and `decode` reads back. An entry is its key
 * as a JSON string, a line break and its value: a JSON string holds no line
 * break. A value that does not encode leaves its unit without a record. */
export function codecTable<V>(
  name: string,
  map: Map<string, V>,
  encode: (value: V) => string | null,
  decode: (text: string) => V,
): JournalTable {
  return {
    name,
    size: () => map.size,
    entries: (from) => {
      const out: string[] = [];
      let index = 0;
      for (const [key, value] of map) {
        if (index++ < from) continue;
        const text = encode(value);
        if (text === null) return null;
        out.push(`${JSON.stringify(key)}\n${text}`);
      }
      return out;
    },
    apply: (entries) => {
      for (const entry of entries) {
        const split = entry.indexOf("\n");
        const key = JSON.parse(entry.slice(0, split)) as string;
        if (!map.has(key)) map.set(key, decode(entry.slice(split + 1)));
      }
    },
    truncate: (from) => {
      const keys = [...map.keys()].slice(from);
      for (const key of keys) map.delete(key);
    },
    hold: () => {
      const keys = [...map.keys()];
      const values = [...map.values()];
      return {
        same: () => {
          let index = 0;
          for (const [key, value] of map) {
            if (index >= keys.length) break;
            if (key !== keys[index] || value !== values[index]) return false;
            index++;
          }
          return index === keys.length;
        },
      };
    },
  };
}

/** An appendable table over a Set of strings. */
export function setTable(name: string, set: Set<string>): JournalTable {
  return {
    name,
    size: () => set.size,
    entries: (from) => [...set].slice(from),
    apply: (entries) => {
      for (const entry of entries) set.add(entry);
    },
    truncate: (from) => {
      const entries = [...set].slice(from);
      for (const entry of entries) set.delete(entry);
    },
    hold: () => {
      const entries = [...set];
      return {
        same: () => {
          let index = 0;
          for (const entry of set) {
            if (index >= entries.length) break;
            if (entry !== entries[index]) return false;
            index++;
          }
          return index === entries.length;
        },
      };
    },
  };
}

/** An appendable list of functions this process holds one of per name. A
 * function whose name the list already holds is the same function, made by
 * an earlier unit. `changed` runs after the list changes, for indexes over
 * it. */
export function functionTable(
  name: string,
  functions: IrFunction[],
  has: (name: string) => boolean,
  changed: () => void = () => {},
): JournalTable {
  return {
    name,
    size: () => functions.length,
    entries: (from) => {
      const out: string[] = [];
      for (const fn of functions.slice(from)) {
        const text = encodeUnitFunction(fn);
        if (text === null) return null;
        out.push(text);
      }
      return out;
    },
    apply: (entries) => {
      for (const entry of entries) {
        const fn = decodeUnitFunction(entry);
        if (!has(fn.name)) functions.push(fn);
      }
      changed();
    },
    truncate: (from) => {
      while (functions.length > from) functions.pop();
      changed();
    },
    hold: () => {
      const held = [...functions];
      return { same: () => held.every((fn, index) => functions[index] === fn) };
    },
    contents: () => {
      const texts: (string | null)[] = [];
      const held: HeldContents = {
        extend: () => {
          for (let index = texts.length; index < functions.length; index++)
            texts.push(encodeUnitFunction(functions[index]!));
        },
        changed: () => {
          for (let index = 0; index < texts.length && index < functions.length; index++)
            if (encodeUnitFunction(functions[index]!) !== texts[index])
              return functions[index]!.name;
          return null;
        },
      };
      held.extend();
      return held;
    },
  };
}

/** A table whose growth leaves the unit without a record. */
export function checkedTable(name: string, size: () => number): JournalTable {
  return { name, size };
}

import { expect, test } from "vitest";
import type { Program, SourceFile } from "../ts7/adapter.js";
import { Lowerer } from "./lowerer.js";
import {
  checkedTable,
  flagScalar,
  functionTable,
  lowerWaveRecorded,
  mapTable,
  recordUnit,
  setTable,
  waveStats,
  type WaveHost,
} from "./unit-journal.js";
import type { IrFunction } from "../../ir/ir.js";

const lowerer = (): Lowerer =>
  new Lowerer(
    { getTypeChecker: () => ({}), isSourceFileDefaultLibrary: () => false } as unknown as Program,
    { fileName: "/island/entry.ts" } as SourceFile,
    [],
  );

const isCollection = (value: unknown): boolean =>
  value instanceof Map || value instanceof Set || Array.isArray(value);

/** The registries whose collections journalSizes covers, with the
 * collections each one's journalSizes reads. */
const sized: Record<string, readonly string[]> = {
  shapes: [
    "keyedNameKeys",
    "byKey",
    "byId",
    "declaredOrderPriority",
    "declaredOrderCandidates",
    "derivedDeclaredOrderFinalizers",
    "shapes",
    "recIds",
    "pendingRec",
    "extendedNames",
  ],
  unions: ["keyedNameKeys", "byKey", "byId", "armTags", "unions", "recIds", "pendingRec"],
  keyOrder: ["literals", "copies", "methodResults", "observed", "changed"],
};

/** Scratch of the registries' own mapping (it unwinds before mapType returns). */
const scratch = new Set([
  "shapes.inProgress",
  "shapes.currentDeclaredOrderPriority",
  "unions.inProgress",
]);

/** Owned objects whose collections are listed one by one. */
const owned = new Set(["coercions", "narrowing", "runtimeOptionalLocals", "positions"]);

test("every collection of the lowerer is journaled, checked or left out by name", () => {
  const subject = lowerer();
  const named = new Set([
    ...subject.journalTables().map((table) => table.name),
    ...Lowerer.unjournaled,
  ]);
  const missing: string[] = [];
  const fields = subject as unknown as Record<string, unknown>;
  for (const field of Object.keys(fields)) {
    const value = fields[field];
    if (isCollection(value)) {
      if (!named.has(field)) missing.push(field);
      continue;
    }
    if (value === null || typeof value !== "object") continue;
    const inner = value as Record<string, unknown>;
    const covered = sized[field];
    if (covered === undefined && !owned.has(field)) continue;
    for (const key of Object.keys(inner)) {
      const path = `${field}.${key}`;
      if (!isCollection(inner[key]) || scratch.has(path)) continue;
      if (covered !== undefined ? !covered.includes(key) : !named.has(path)) missing.push(path);
    }
  }
  expect(missing).toEqual([]);
});

test("every scalar field of the lowerer is journaled or left out by name", () => {
  const subject = lowerer();
  const named = new Set([
    ...subject.journalScalars().map((scalar) => scalar.name),
    ...Lowerer.unjournaled,
  ]);
  const fields = subject as unknown as Record<string, unknown>;
  const missing = Object.keys(fields).filter((field) => {
    const value = fields[field];
    if (isCollection(value) || typeof value === "function") return false;
    const scalar = value === null || value === undefined || typeof value !== "object";
    return scalar && !named.has(field);
  });
  expect(missing).toEqual([]);
});

test("every name the lists hold is a field of the lowerer", () => {
  const subject = lowerer();
  const fields = subject as unknown as Record<string, unknown>;
  const names = [
    ...subject.journalTables().map((table) => table.name),
    ...subject.journalScalars().map((scalar) => scalar.name),
    ...Lowerer.unjournaled,
  ];
  const missing = names.filter((name) => {
    const [head, key] = name.split(".");
    if (!(head! in fields)) return true;
    if (key === undefined) return false;
    const inner = fields[head!];
    return inner === null || typeof inner !== "object" || !(key in inner);
  });
  expect(missing).toEqual([]);
});

const fn = (name: string, ret: "f64" | "string" = "f64"): IrFunction =>
  ({
    name,
    params: [],
    returnType: { kind: ret },
    locals: [],
    body: [],
    loc: { file: "a.ts", start: 0, end: 0 },
  }) as unknown as IrFunction;

test("a map table hands over the entries added after a size", () => {
  const map = new Map<string, string>([["a", "%h.1"]]);
  const table = mapTable("helpers", map);
  map.set("b", "%h.2");
  map.set("c", "%h.3");
  const entries = table.entries!(1)!;
  expect(entries.length).toBe(2);
  const parent = new Map<string, string>([
    ["a", "%h.1"],
    ["c", "%h.3"],
  ]);
  mapTable("helpers", parent).apply!(entries);
  expect([...parent]).toEqual([
    ["a", "%h.1"],
    ["c", "%h.3"],
    ["b", "%h.2"],
  ]);
  table.truncate!(1);
  expect([...map]).toEqual([["a", "%h.1"]]);
});

test("a held table notices a replaced entry", () => {
  const map = new Map<string, string>([["a", "%h.1"]]);
  const held = mapTable("helpers", map).hold!();
  map.set("b", "%h.2");
  expect(held.same()).toBe(true);
  map.set("a", "%h.9");
  expect(held.same()).toBe(false);
  const set = new Set(["x"]);
  const heldSet = setTable("names", set).hold!();
  set.delete("x");
  set.add("x");
  expect(heldSet.same()).toBe(true);
  set.delete("x");
  expect(heldSet.same()).toBe(false);
});

test("a function table keeps the function an earlier unit made", () => {
  const worker = [fn("%a")];
  const table = functionTable("lifted", worker, () => false);
  worker.push(fn("%b"), fn("%c"));
  const entries = table.entries!(1)!;
  const parent = [fn("%c", "string")];
  const target = functionTable("lifted", parent, (name) =>
    parent.some((other) => other.name === name),
  );
  target.apply!(entries);
  expect(parent.map((f) => [f.name, f.returnType.kind])).toEqual([
    ["%c", "string"],
    ["%b", "f64"],
  ]);
});

test("a set table adds what the parent lacks", () => {
  const set = new Set(["x"]);
  const table = setTable("names", set);
  set.add("y");
  const parent = new Set<string>();
  setTable("names", parent).apply!(table.entries!(1)!);
  expect([...parent]).toEqual(["y"]);
});

/** A wave host over one helper map, one checked list and one flag, whose
 * units are lowered by `lower`. */
function host(lower: (name: string, state: HostState) => IrFunction | null): {
  host: WaveHost;
  state: HostState;
} {
  const state: HostState = { helpers: new Map(), checked: [], flag: false, stored: new Map() };
  return {
    state,
    host: {
      tables: [
        mapTable("helpers", state.helpers),
        checkedTable("checked", () => state.checked.length),
      ],
      scalars: [
        flagScalar(
          "flag",
          () => state.flag,
          () => (state.flag = true),
        ),
      ],
      lowerRecorded: (name, events) => {
        events.record("edge", `%callee.${name}`);
        return { fn: lower(name, state), poisoned: false };
      },
      store: (name, unitFn) => {
        if (unitFn !== null) state.stored.set(name, unitFn);
      },
      statementCounts: () => ({ total: 0, failed: 0, other: 0 }),
      resolves: () => true,
    },
  };
}

interface HostState {
  helpers: Map<string, string>;
  checked: string[];
  flag: boolean;
  stored: Map<string, IrFunction>;
}

test("a recorded wave keeps what the records carry, in wave order", () => {
  const made = new Map<string, IrFunction>();
  const { host: subject, state } = host((name, held) => {
    held.helpers.set(`key.${name}`, `%h.${name}`);
    if (name === "b") held.flag = true;
    if (name === "c") held.checked.push(name);
    const unitFn = fn(`%${name}`);
    made.set(name, unitFn);
    return unitFn;
  });
  const stats = waveStats();
  lowerWaveRecorded(subject, ["a", "b", "c"], stats);
  expect([...state.helpers.keys()]).toEqual(["key.a", "key.b", "key.c"]);
  expect(stats).toMatchObject({
    waves: 1,
    units: 3,
    recorded: 2,
    unrecorded: 1,
    reasons: { checked: 1 },
  });
  // Recorded units keep the function decoded from their record; the unit
  // without one keeps the function lowering made.
  expect(state.stored.get("a")).not.toBe(made.get("a"));
  expect(state.stored.get("a")).toEqual(made.get("a"));
  expect(state.stored.get("c")).toBe(made.get("c"));
});

test("a unit's record lists its events, flags and added entries", () => {
  const { host: subject } = host((name, held) => {
    held.helpers.set(`key.${name}`, `%h.${name}`);
    held.flag = true;
    return fn(`%${name}`);
  });
  const { record } = recordUnit(subject, "a");
  expect(record).not.toBeNull();
  expect(record!.events.map((event) => [event.kind, event.name])).toEqual([
    ["edge", "%callee.a"],
    ["flag", "flag"],
  ]);
  expect(record!.tables).toEqual({ helpers: [`"key.a"\n"%h.a"`] });
  expect(JSON.parse(JSON.stringify(record))).toEqual(record);
});

test("a unit that changes an entry it did not add has no record", () => {
  const { host: subject, state } = host((name, held) => {
    held.helpers.set("shared", `%h.${name}`);
    return null;
  });
  state.helpers.set("shared", "%h.first");
  const unit = recordUnit(subject, "a");
  expect(unit.record).toBeNull();
  expect(unit.reasons).toEqual(["helpers:replaced"]);
});

test("a recorded wave throws when a unit changes a held function in place", () => {
  const functions = [fn("%shared")];
  const subject: WaveHost = {
    tables: [functionTable("lifted", functions, (name) => functions.some((f) => f.name === name))],
    scalars: [],
    lowerRecorded: (name) => {
      if (name === "b")
        functions[0]!.locals.push({ id: "x.0", name: "x", type: { kind: "f64" } } as never);
      return { fn: fn(`%${name}`), poisoned: false };
    },
    store: () => {},
    statementCounts: () => ({ total: 0, failed: 0, other: 0 }),
    resolves: () => true,
  };
  lowerWaveRecorded(subject, ["a"], waveStats());
  expect(() => lowerWaveRecorded(subject, ["a", "b"], waveStats())).toThrow(
    "a unit changed lifted entry %shared in place",
  );
});

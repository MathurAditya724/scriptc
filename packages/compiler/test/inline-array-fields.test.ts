import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

// InlineArray fields (@scriptc/experimental, ir/inline-arrays.ts): the
// elements of a ProgramLifetime class's array field written once from a
// constructor parameter live in the instance, after its fixed fields.

const header = `
import type { ProgramLifetime } from "@scriptc/types";
import type { InlineArray } from "@scriptc/experimental";
`;

async function build(
  source: string,
): Promise<{ ok: boolean; codes: string[]; llvm: string; messages: string[] }> {
  // Inside the workspace, so that the program resolves both packages.
  const dir = await mkdtemp(join(import.meta.dirname, ".inline-array-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ll");
    await writeFile(entry, header + source);
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "llvm" });
    const llvm = result.ok ? await readFile(outPath, "utf8") : "";
    return {
      ok: result.ok,
      codes: (result.diagnostics ?? []).map((d) => d.code),
      messages: (result.diagnostics ?? []).map((d) => d.message),
      llvm,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const classes = `
class Item implements ProgramLifetime {
  readonly kind: number;
  constructor(kind: number) {
    this.kind = kind;
  }
}
class List implements ProgramLifetime {
  readonly pos: number;
  readonly items: InlineArray<Item>;
  constructor(pos: number, items: readonly Item[]) {
    this.pos = pos;
    this.items = items;
  }
}
class Flagged extends List {
  readonly flags: number;
  constructor(pos: number, items: readonly Item[], flags: number) {
    super(pos, items);
    this.flags = flags;
  }
}
`;

const body = (fn: string, llvm: string): string =>
  new RegExp(`^define internal [^@]+@sc_bf_${fn}\\([^]*?^}`, "m").exec(llvm)?.[0] ?? "";

// The inline layout applies to executables whose compact instances live in
// the low region: Linux, 64-bit.
const lowRegion =
  process.platform === "linux" && (process.arch === "x64" || process.arch === "arm64");

test.runIf(lowRegion)("the elements follow the fixed fields, which keep their count", async () => {
  const { ok, llvm } = await build(
    classes +
      `
const a = new List(1, [new Item(1), new Item(2)]);
const b = new Flagged(2, [new Item(3)], 7);
console.log(a.items.length, b.items.length, b.flags);
`,
  );
  expect(ok).toBe(true);
  // The field's slot is an i32: the header, pos and the count.
  expect(llvm).toMatch(/^%sc_o_List = type \{ i32, i32, i32 \}/m);
  expect(llvm).toMatch(/^%sc_o_Flagged = type \{ i32, i32, i32, i32 \}/m);
  // `new` takes the count and allocates room for the 32-bit references
  // after the largest fixed part in the subtree (Flagged's 16 bytes).
  expect(llvm).toContain("define internal ptr @sc_new_List(i32 %inl.len)");
  expect(llvm).toContain("%inl.size = add nuw nsw i64 %inl.bytes, 16");
  // The constructor copies the argument's elements into the instance.
  expect(llvm).toContain("call void @scr_arr_copy_cref_tail(");
});

test.runIf(lowRegion)("indexing, length and local aliases read the instance", async () => {
  const { ok, llvm } = await build(
    classes +
      `
function sum(list: List): number {
  let s = 0;
  const items = list.items;
  for (let i = 0; i < items.length; i++) s += items[i]!.kind;
  for (const item of list.items) s += item.kind;
  return s + list.items[0]!.kind;
}
const list = new List(0, [new Item(1), new Item(2)]);
console.log(sum(list));
`,
  );
  expect(ok).toBe(true);
  const sum = body("sum", llvm);
  expect(sum).not.toBe("");
  // Elements are 32-bit references loaded from the instance; only the
  // out-of-bounds path makes an array of them, for the runtime getter.
  expect(sum).toMatch(/getelementptr inbounds i32, ptr %\S+, i64 %\S+\n\s*%\S+ = load i32/);
  const hits = sum.split(/\n(?=\S)/).filter((block) => block.startsWith("inl.get.hit"));
  expect(hits.length).toBeGreaterThan(0);
  for (const block of hits) expect(block).not.toContain("scr_arr_view_cref");
  for (const line of sum.split("\n").filter((l) => l.includes("scr_arr_view_cref(")))
    expect(line).not.toContain("scr_arr_get_ref");
});

test.runIf(lowRegion)("for...of tests presence on the instance", async () => {
  const { ok, llvm } = await build(
    classes +
      `
// An array that may have holes: each loop over a list tests each index.
function holed(items: readonly Item[]): Item[] {
  const out: Item[] = new Array<Item>(items.length);
  for (let i = 0; i < items.length; i++) out[i] = items[i]!;
  return out;
}
function kinds(list: List): number {
  let s = 0;
  for (const item of list.items) s += item.kind;
  return s;
}
console.log(kinds(new List(0, holed([new Item(1), new Item(2)]))));
`,
  );
  expect(ok).toBe(true);
  const kinds = body("kinds", llvm);
  expect(kinds).not.toBe("");
  expect(kinds).not.toContain("scr_arr_state");
  // Only an index outside the count makes an array, for the runtime getter.
  for (const block of kinds.split(/\n(?=\S)/).filter((b) => b.includes("scr_arr_view_cref(")))
    expect(block.startsWith("inl.get.miss")).toBe(true);
});

test.runIf(lowRegion)("a read that escapes gives an array of the elements", async () => {
  const { ok, llvm } = await build(
    classes +
      `
function count(items: readonly Item[]): number {
  return items.length;
}
function use(list: List): number {
  return count(list.items) + list.items.indexOf(list.items[0]!);
}
console.log(use(new List(0, [new Item(1)])));
`,
  );
  expect(ok).toBe(true);
  expect(body("use", llvm)).toContain("call ptr @scr_arr_view_cref(");
});

test("an InlineArray field must keep its contract", async () => {
  const twice = await build(`
class Item implements ProgramLifetime {}
class List implements ProgramLifetime {
  readonly items: InlineArray<Item>;
  constructor(items: readonly Item[], more: readonly Item[]) {
    this.items = items;
    if (more.length > 0) (this as { items: readonly Item[] }).items = more;
  }
}
console.log(new List([new Item()], []).items.length);
`);
  expect(twice.ok).toBe(false);
  expect(twice.codes).toContain("SC7009");

  const mortal = await build(`
class Item implements ProgramLifetime {}
class List {
  readonly items: InlineArray<Item>;
  constructor(items: readonly Item[]) {
    this.items = items;
  }
}
console.log(new List([new Item()]).items.length);
`);
  expect(mortal.ok).toBe(false);
  expect(mortal.codes).toContain("SC7009");
  expect(mortal.messages.join("\n")).toContain("not ProgramLifetime");

  const computed = await build(`
class Item implements ProgramLifetime {}
class List implements ProgramLifetime {
  readonly items: InlineArray<Item>;
  constructor(n: number) {
    const items: Item[] = [];
    for (let i = 0; i < n; i++) items.push(new Item());
    this.items = items;
  }
}
console.log(new List(2).items.length);
`);
  expect(computed.ok).toBe(false);
  expect(computed.codes).toContain("SC7009");
  expect(computed.messages.join("\n")).toContain("constructor parameter");
});

test("a read of an InlineArray field is not compared by identity", async () => {
  const result = await build(`
class Item implements ProgramLifetime {}
class List implements ProgramLifetime {
  readonly items: InlineArray<Item>;
  constructor(items: readonly Item[]) {
    this.items = items;
  }
}
const items = [new Item()];
const list = new List(items);
console.log(list.items === items);
`);
  expect(result.ok).toBe(false);
  expect(result.codes).toContain("SC7009");
  expect(result.messages.join("\n")).toContain("compared by identity");
});

test("InlineArray is checked on instance fields only", async () => {
  const result = await build(`
class Item implements ProgramLifetime {}
function count(items: InlineArray<Item>): number {
  return items.length;
}
console.log(count([new Item()]));
`);
  expect(result.ok).toBe(false);
  expect(result.codes).toContain("SC7006");
});

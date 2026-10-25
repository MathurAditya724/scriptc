import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { compile } from "../src/index.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function emit(source: string): Promise<string> {
  const outDir = await mkdtemp(join(tmpdir(), "scriptc-function-table-"));
  directories.push(outDir);
  const entry = join(outDir, "main.ts");
  await writeFile(entry, source);
  const outPath = join(outDir, "program.ll");
  const result = await compile(entry, { entry, outDir, outPath, outputKind: "llvm" });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  return readFile(outPath, "utf8");
}

function definition(llvm: string, symbol: string): string {
  const match = new RegExp(`^define internal [^\\n]*@${symbol}(?:\\.i32)?\\([^]*?^}`, "m").exec(
    llvm,
  );
  expect(match, symbol).not.toBeNull();
  return match![0];
}

// A record of functions dispatched by key: the hit lends the stored closure
// to the call (no union box, no lookup through the runtime, no closure
// retain or release), and only a miss tests the key against
// Object.prototype's method names.
const source = `
type Op = (acc: number, arg: number) => number;
const ops: Record<string, Op> = {
  add: (acc, arg) => acc + arg,
  neg: (acc) => -acc,
};
function asserted(name: string, acc: number): number {
  return ops[name]!(acc, 1);
}
function optional(name: string, acc: number): number {
  return ops[name]?.(acc, 1) ?? acc;
}
// Object arguments: the inherited methods' key conversion must not make
// every indirect call a heap writer (which would end all borrowing).
class Point {
  constructor(readonly x: number) {}
}
type Measure = (p: Point, q: Point) => number;
const measures: Record<string, Measure> = { sum: (p, q) => p.x + q.x };
function objects(name: string, p: Point): number {
  return measures[name]!(p, p);
}
function checked(name: string, acc: number): number {
  const handler = ops[name];
  return handler ? handler(acc, 1) : acc;
}
let acc = 1;
for (const name of ["add", "neg", "nope", "toString"]) {
  acc = asserted(name === "nope" ? "add" : name === "toString" ? "neg" : name, acc);
  acc = optional(name, acc);
  acc = checked(name, acc);
  acc += objects(name === "nope" ? "sum" : "sum", new Point(acc));
}
console.log(acc);
`;

test("function-table dispatch borrows the stored closure on a hit", async () => {
  const llvm = await emit(source);
  for (const fn of ["asserted", "optional", "checked", "objects"]) {
    const body = definition(llvm, `sc_bf_${fn}`);
    expect(body, fn).not.toMatch(/scr_union_new_ref|scr_map_get_str_ref/);
    expect(body, fn).not.toMatch(/scr_closure_retain|sc_nretain_func/);
    expect(body, fn).toMatch(/sc_map_entry_str/);
  }
});

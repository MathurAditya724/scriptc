import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../src/index.js";
import type { IrModule } from "../src/ir/ir.js";
import { markInt32ArrayCandidates, selectInt32Arrays } from "../src/ir/int32-arrays.js";

async function emitLlvm(source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-int32-elements-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ll");
    await writeFile(entry, source);
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "llvm" });
    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
    return await readFile(outPath, "utf8");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function lowerIr(source: string): Promise<IrModule> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-int32-elements-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ir.json");
    await writeFile(entry, source);
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
    return deserializeModule(await readFile(outPath, "utf8"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const source = `
function compose(n: number, rounds: number): number {
  const p: number[] = [];
  const q: number[] = [];
  for (let i = 0; i < n; i++) p.push((i * 7919 + 3) & (n - 1));
  for (let i = 0; i < n; i++) q.push(i);
  let check = 0;
  for (let r = 0; r < rounds; r++) {
    for (let i = 0; i < n; i++) q[i] = p[q[i]!]!;
    check = (check + q[r % n]!) | 0;
  }
  return check;
}
function counts(n: number): number {
  const c = new Array(n).fill(0) as number[];
  for (let i = 0; i < n; i++) c[(i * 5) % n] = i;
  while (c.length > 1) c.pop();
  return c[0]!;
}
function fraction(n: number): number {
  const a = [1, 2, 3];
  a[1] = n / 3;
  return a[1]!;
}
function negativeZero(): number {
  const a = [1, -0];
  return 1 / a[1]!;
}
function counter(n: number): number {
  const a = [0];
  for (let i = 0; i < n; i++) a[0] = a[0]! + 1;
  return a[0]!;
}
function joined(n: number): string {
  const a = [n | 0, 2];
  return a.join(",");
}
const { n } = JSON.parse('{"n": 8}') as { n: number };
console.log(compose(n | 0, 3), counts(n | 0), fraction(n), negativeZero(), counter(n), joined(n));
`;

/** Every function emitted for the source function \`name\` (its int32 ABI
 * body and its wrapper included). */
function functions(llvm: string, name: string): string {
  const pattern = new RegExp(`^define [^@]*@sc_b?f_${name}[.\\w]*\\([^]*?^}`, "gm");
  return [...llvm.matchAll(pattern)].map((m) => m[0]).join("\n");
}

test("arrays storing only int32 elements get 4-byte slots", async () => {
  const llvm = await emitLlvm(source);
  const compose = functions(llvm, "compose");
  expect(compose).not.toBe("");
  // Both arrays are allocated as SCR_ELEM_I32 (7).
  expect(compose.match(/@scr_arr_new_small\(i32 7\)/g)?.length).toBe(2);
  // Reads load an i32 slot; writes store one.
  expect(compose).toMatch(/getelementptr inbounds i32, ptr %\w+, i64 %\w+\n\s+%\w+ = load i32/);
  expect(compose).toMatch(/store i32 %\w+, ptr %\w+, !tbaa/);
  // The element read through the helper's ternary stays in a stack box.
  expect(compose).not.toContain("@scr_union_new_f64");
  expect(compose).not.toMatch(/call [^\n]*@sc_b?f__x25_arr_idxOr/);
  // The fill form and a discarded pop.
  const counts = functions(llvm, "counts");
  expect(counts).toMatch(/@scr_arr_new\(i32 7, i64 0\)/);
  expect(counts).not.toContain("popArray");
});

test("arrays with a store that may not be an int32, or that escape, keep doubles", async () => {
  const llvm = await emitLlvm(source);
  for (const name of ["fraction", "negativeZero", "counter", "joined"]) {
    const fn = functions(llvm, name);
    expect(fn, name).not.toBe("");
    expect(fn, name).not.toMatch(/@scr_arr_new(_small)?\(i32 7/);
  }
});

test("only the candidates the proof keeps are rewritten", async () => {
  const mod = await lowerIr(source);
  const proposed = markInt32ArrayCandidates(mod).int32ArrayCandidates ?? [];
  expect(proposed).toEqual(
    expect.arrayContaining(["compose\0p.0", "compose\0q.0", "counts\0c.0", "counter\0a.0"]),
  );
  // An array that reaches `join` is never proposed.
  expect(proposed.some((key) => key.startsWith("joined\0"))).toBe(false);
  // Without a kept candidate, the module is the input itself.
  expect(selectInt32Arrays(mod, () => new Set())).toBe(mod);
  const kept = new Set(["compose\0p.0", "compose\0q.0"]);
  const selected = selectInt32Arrays(
    mod,
    (marked) => new Set((marked.int32ArrayCandidates ?? []).filter((key) => kept.has(key))),
  );
  expect(selected.int32ArrayCandidates).toEqual([...kept]);
  for (const fn of selected.functions)
    if (fn.name !== "compose") expect(fn).toBe(mod.functions.find((f) => f.name === fn.name));
});

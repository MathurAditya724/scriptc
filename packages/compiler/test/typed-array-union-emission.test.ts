import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

async function emitLlvm(source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-typed-array-unions-"));
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

function body(llvm: string, name: string): string {
  return new RegExp(`^define [^@]*@sc_b?f_${name}(\\.i32)?\\([^]*?^}`, "m").exec(llvm)?.[0] ?? "";
}

const source = `
type UintArray = Uint8Array | Uint16Array | Uint32Array;
const pick = (max: number, n: number): UintArray =>
  max <= 256 ? new Uint8Array(n) : max <= 65536 ? new Uint16Array(n) : new Uint32Array(n);
function total(xs: UintArray): number {
  let s = 0;
  for (let i = 0; i < xs.length; i++) s += xs[i]!;
  return s;
}
function first(max: number): number {
  return pick(max, 4)[0]!;
}
const xs = pick(Number(process.argv.length) * 100000, 8);
for (let i = 0; i < xs.length; i++) xs[i] = i;
console.log(total(xs), first(10));
`;

test("element reads of a union of typed arrays load each arm's own element kind in place", async () => {
  const llvm = await emitLlvm(source);
  const total = body(llvm, "total");
  // One load per arm, each of its element width, behind the union's tag.
  for (const width of ["i8", "i16", "i32"]) expect(total).toMatch(new RegExp(`load ${width}, ptr`));
  expect(total).not.toContain("@sc_bf__x25_union_getNumber");
  // The loop over the union's length keeps an integer counter.
  expect(total).toMatch(/alloca i64/);
});

test("a typed-array union read through a computed receiver goes through one helper", async () => {
  const llvm = await emitLlvm(source);
  // The receiver is a call: evaluated once, then dispatched by the helper.
  expect(body(llvm, "first")).toContain("@sc_bf__x25_union_getNumber");
});

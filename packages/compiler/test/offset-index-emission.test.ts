import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

async function emitLlvm(source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-offset-index-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ll");
    await writeFile(entry, source);
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "llvm" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    return await readFile(outPath, "utf8");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("typed array accesses at a number base plus an integer convert the base, not the sum", async () => {
  const llvm = await emitLlvm(`
function window(values: Float64Array, at: number): number {
  return values[at + 0]! + values[at + 1]! + values[2 + at]! + values[at - 1]!;
}
const values = new Float64Array([1, 2, 3, 4, 5, 6]);
console.log(window(values, Number(process.argv[2] ?? "1")));
`);
  const start = llvm.indexOf("@sc_bf_window(");
  const body = llvm.slice(start, llvm.indexOf("\n}\n", start));
  const sums = new Set([...body.matchAll(/(%t\d+) = fadd double/g)].map((m) => m[1]));
  const converted = [...body.matchAll(/fptosi double (%[\w.]+) to i64/g)].map((m) => m[1]);
  expect(converted.length).toBeGreaterThanOrEqual(4);
  // Each access converts the base and adds its offset as an integer.
  expect(converted.filter((name) => sums.has(name))).toEqual([]);
  for (const offset of [1, 2, -1])
    expect(body).toMatch(new RegExp(`= add i64 %t\\d+, ${offset}\\n`));
});

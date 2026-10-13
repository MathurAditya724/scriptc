import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, compileLibrary } from "../src/index.js";

async function emitLlvm(source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-constructed-dispatch-"));
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

/** The vtable slot load a virtual call of `method` emits. */
const slotLoad = (method: string): RegExp => new RegExp(`= load ptr, ptr %t\\d+ ; ${method}\\n`);
const directCall = (cls: string, method: string): RegExp =>
  new RegExp(`call double @sc_bf__x25_${cls}_${method}\\(`);

const loop = `
function run(s: Shape, n: number): number {
  let t = 0;
  for (let i = 0; i < n; i++) t += s.area(i & 1023);
  return t;
}
`;

test("an abstract base with one constructed implementation calls it directly", async () => {
  const llvm = await emitLlvm(`
abstract class Shape { abstract area(x: number): number; }
class Circle extends Shape { r = 2; area(x: number): number { return x * this.r + 1; } }
class Square extends Shape { s = 3; area(x: number): number { return x * this.s; } }
function make(): Shape { return new Circle(); }
${loop}
console.log(run(make(), 1000));
`);
  expect(llvm).toMatch(directCall("Circle", "area"));
  expect(llvm).not.toMatch(slotLoad("area"));
});

test("a concrete base reached only through super() calls the subclass directly", async () => {
  const llvm = await emitLlvm(`
class Shape { f = 1; area(x: number): number { return x * this.f; } }
class Circle extends Shape { r = 2; area(x: number): number { return x * this.r + 1; } }
function make(): Shape { return new Circle(); }
${loop}
console.log(run(make(), 1000));
`);
  expect(llvm).toMatch(directCall("Circle", "area"));
  expect(llvm).not.toMatch(slotLoad("area"));
});

test("two constructed implementations keep the vtable call", async () => {
  const llvm = await emitLlvm(`
abstract class Shape { abstract area(x: number): number; }
class Circle extends Shape { r = 2; area(x: number): number { return x * this.r + 1; } }
class Square extends Shape { s = 3; area(x: number): number { return x * this.s; } }
${loop}
console.log(run(new Circle(), 1000), run(new Square(), 1000));
`);
  expect(llvm).toMatch(slotLoad("area"));
});

test("a constructed concrete base keeps the vtable call", async () => {
  const llvm = await emitLlvm(`
class Shape { f = 1; area(x: number): number { return x * this.f; } }
class Circle extends Shape { r = 2; area(x: number): number { return x * this.r + 1; } }
${loop}
console.log(run(new Circle(), 1000), run(new Shape(), 1000));
`);
  expect(llvm).toMatch(slotLoad("area"));
});

test("a class value of a subclass keeps the vtable call", async () => {
  const llvm = await emitLlvm(`
abstract class Shape { abstract area(x: number): number; }
class Circle extends Shape { r = 2; area(x: number): number { return x * this.r + 1; } }
class Square extends Shape { s = 3; area(x: number): number { return x * this.s; } }
const kinds: unknown[] = [Square];
${loop}
console.log(run(new Circle(), 1000), kinds.length);
`);
  expect(llvm).toMatch(slotLoad("area"));
});

test("library mode keeps the vtable call for an exported class", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-constructed-dispatch-lib-"));
  try {
    await writeFile(
      join(dir, "entry.ts"),
      `
export abstract class Shape { abstract area(x: number): number; }
export class Circle extends Shape { r = 2; area(x: number): number { return x * this.r + 1; } }
abstract class Inner { abstract size(x: number): number; }
class Leaf extends Inner { size(x: number): number { return x + 1; } }
function measure(s: Inner, x: number): number { return s.size(x); }
${loop}
export function result(): number { return run(new Circle(), 10) + measure(new Leaf(), 1); }
`,
    );
    const profilePath = join(dir, "profile.json");
    await writeFile(
      profilePath,
      JSON.stringify({
        profile_format: 1,
        name: "constructed-dispatch",
        entry: "entry.ts",
        emission: "llvm",
        abi: {
          prefix: "cd_",
          init_symbol: "cd_init",
          sink_register_symbol: "cd_sink",
          collect_symbol: "cd_collect",
        },
        exports: [{ export: "result", symbol: "cd_result", params: [], returns: "f64" }],
      }),
    );
    const result = await compileLibrary({ profilePath, outDir: join(dir, "out") });
    expect(result.ok, JSON.stringify(result.ok ? [] : result.diagnostics)).toBe(true);
    if (!result.ok) return;
    const llvm = await readFile(result.llvmPath, "utf8");
    expect(llvm).toMatch(slotLoad("area"));
    expect(llvm).not.toMatch(slotLoad("size"));
    expect(llvm).toMatch(directCall("Leaf", "size"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

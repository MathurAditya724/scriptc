import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../src/index.js";
import { emitLlvmModule } from "../src/backend/llvm/emitter.js";

test("counted loops guard exact induction and preserve wide remainders on both pointer widths", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-counted-loops-"));
  try {
    const entry = join(import.meta.dirname, "../../../tests/corpus/counted-loop-numbers.ts");
    const outPath = join(dir, "numbers.ir.json");
    const result = await compile(entry, { outPath, outDir: dir, outputKind: "ir" });
    if (!result.ok) throw new Error(result.diagnostics.map((d) => d.message).join("\n"));
    const mod = deserializeModule(await readFile(outPath, "utf8"));
    const body = (ll: string, name: string): string =>
      ll.match(
        new RegExp(
          `define internal [^\\n]+ @sc_f_${name}(?:\\.i32)?\\([^\\n]*\\) #0 \\{([\\s\\S]*?)\\n\\}`,
        ),
      )![1]!;
    for (const pointerBits of [32, 64] as const) {
      const ll = emitLlvmModule(mod, { pointerBits, wasi: pointerBits === 32 });
      const exclusive = body(ll, "exclusive");
      expect(exclusive).toContain("counted.fast");
      expect(exclusive).toContain("counted.slow");
      expect(exclusive).toContain("fcmp ole double");
      expect(exclusive).toContain("alloca i64 ; integer induction i");
      const fast = exclusive.slice(exclusive.indexOf("\ncounted.fast"));
      expect(fast).toContain("urem i64");
      expect(fast).not.toContain("uint32.coerce");
      expect(body(ll, "inclusive")).toContain("fcmp ole double");
      expect(body(ll, "inclusive")).toContain("0x433FFFFFFFFFFFFF");
      expect(body(ll, "wide")).toMatch(/urem i64 %\w+, 4294967297/);
      for (const name of ["changed", "captured"])
        expect(body(ll, name)).not.toContain("counted.fast");
      expect(body(ll, "remainders")).toContain("frem double");
    }
    const debug = emitLlvmModule(mod, {
      debugSources: new Map([[entry, await readFile(entry, "utf8")]]),
    });
    expect(debug).not.toContain("counted.fast");
    expect(debug).toContain("@llvm.dbg.declare");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("worker programs poll counted loops over typed arrays between blocks of iterations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-counted-poll-"));
  try {
    const source = (workers: boolean): string =>
      [
        workers ? 'import { isMainThread, Worker } from "node:worker_threads";' : "",
        "export function scale(a: Float64Array, b: Float64Array, n: number): void {",
        "  for (let i = 0; i < n; i++) b[i] = a[i]! * 2;",
        "}",
        "export function codes(a: Uint8Array): void {",
        "  for (let i = 0; i < a.length; ++i) a[i] = a[i] === 97 ? 0 : 3;",
        "}",
        "export function mix(n: number): number {",
        "  let t = 0;",
        "  for (let i = 0; i < n; i++) t = (t * 31 + i) % 1000003;",
        "  return t;",
        "}",
        "const a = new Float64Array(8).fill(1);",
        "const b = new Float64Array(8);",
        "scale(a, b, 8);",
        "const c = new Uint8Array(8).fill(97);",
        "codes(c);",
        "console.log(b[7], mix(8), c[0]);",
        workers ? "if (!isMainThread) new Worker(new URL(import.meta.url));" : "",
      ].join("\n");
    const emit = async (workers: boolean): Promise<string> => {
      const entry = join(dir, `${workers ? "worker" : "plain"}.ts`);
      await writeFile(entry, source(workers));
      const outPath = join(dir, `${workers ? "worker" : "plain"}.ir.json`);
      const result = await compile(entry, { outPath, outDir: dir, outputKind: "ir" });
      if (!result.ok) throw new Error(result.diagnostics.map((d) => d.message).join("\n"));
      return emitLlvmModule(deserializeModule(await readFile(outPath, "utf8")));
    };
    // Every emitted version of a function (the number and int32 entries).
    const bodies = (ll: string, name: string): string =>
      [
        ...ll.matchAll(
          new RegExp(
            `define internal [^\\n]+ @sc_b?f_${name}(?:\\.i32)?\\([^\\n]*\\n([\\s\\S]*?)\\n\\}`,
            "g",
          ),
        ),
      ]
        .map((match) => match[1]!)
        .join("\n");
    const workerModule = await emit(true);
    const worker = bodies(workerModule, "scale");
    const blocks = worker.split(/\n(?=[\w.]+:)/);
    // No budget in the body: the inner loop's latch only steps the counter,
    // the poll runs after each block, and the block's bound is the nearer of
    // the limit and 64 steps on.
    expect(worker).not.toContain("worker cancellation budget");
    expect(worker).toContain("@llvm.sadd.sat.i64(i64 %");
    expect(worker).toMatch(/@llvm\.smin\.i64\(i64 %\w+, i64 %\w+\)/);
    for (const latch of blocks.filter((block) => block.startsWith("loop.u")))
      expect(latch).not.toContain("scr_exc_flag");
    const polls = blocks.filter((block) => block.startsWith("loop.poll"));
    expect(polls.length).toBeGreaterThan(0);
    for (const poll of polls) expect(poll).toContain("@scr_exc_flag");
    // A counted loop without typed-array accesses keeps the budget.
    // A loop to a typed array's length is strip-mined the same way, with the
    // length as each block's limit.
    const codes = bodies(workerModule, "codes");
    expect(codes).not.toContain("worker cancellation budget");
    expect(codes).toMatch(/@llvm\.uadd\.sat\.i64\(i64 %\w+, i64 64\)/);
    expect(codes).toMatch(/@llvm\.umin\.i64\(i64 %\w+, i64 %\w+\)/);
    expect(codes).toMatch(/^loop\.poll\d+:$/m);
    const mix = bodies(workerModule, "mix");
    expect(mix).toContain("worker cancellation budget");
    expect(mix).not.toContain("loop.poll");
    const plain = bodies(await emit(false), "scale");
    expect(plain).not.toContain("loop.poll");
    expect(plain).not.toContain("@scr_exc_flag");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

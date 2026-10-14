/* Lifetime regions (@scriptc/experimental LifetimeRegion): the corpus
 * programs pin Node.js parity; this suite runs the same programs with
 * SCRIPTC_REGION_STATS=1 and checks what the runtime did with each region:
 * freed, kept while something outside still refers into it, or pinned by
 * publication. A program that releases a region while an outside
 * reference survives must keep it (and keep working), never free it.
 * SCRIPTC_SAN=1 builds with ASan and the RC audit, where freed regions
 * stay mapped without access, so any use of a freed object faults. */
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const exec = promisify(execFile);
const corpus = join(import.meta.dirname, "../corpus");
const sanitize = process.env["SCRIPTC_SAN"] === "1";

interface Stats {
  /** "<region> freed|kept|pinned" per release attempt, in order (one thread). */
  attempts: string[];
  /** Per-thread summaries, sorted. */
  summaries: string[];
  stdout: string;
}

async function run(program: string): Promise<Stats> {
  const outDir = await mkdtemp(join(tmpdir(), "scriptc-regions-"));
  try {
    const result = await compile(join(corpus, program), {
      backend: "llvm",
      sanitize,
      outDir,
      outPath: join(outDir, "program"),
    });
    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
    if (!result.ok) throw new Error("compile failed");
    const { stdout, stderr } = await exec(result.binaryPath, [], {
      env: { ...process.env, SCRIPTC_REGION_STATS: "1" },
      timeout: 120_000,
    });
    const stats: Stats = { attempts: [], summaries: [], stdout };
    for (const line of stderr.split("\n")) {
      if (line === "" || line.startsWith("scriptc RC audit skipped:")) continue;
      const attempt = /^scriptc region (\d+): (freed|kept|pinned)\b/.exec(line);
      if (attempt) stats.attempts.push(`${attempt[1]} ${attempt[2]}`);
      else if (line.startsWith("scriptc regions: ")) stats.summaries.push(line.slice(17));
      // A region whose free left counted references would print here.
      else if (!/^==\d+==WARNING: ASan doesn't fully support makecontext/.test(line))
        throw new Error(`unexpected stderr line: ${line}`);
    }
    stats.summaries.sort();
    return stats;
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
}

const summary = (created: number, freed: number, pinned = 0, released = created): string =>
  `${created} created, ${released} released, ${freed} freed, ${pinned} pinned, ${released - freed - pinned} kept`;

/** Every region was kept by an outside reference first, then freed. */
function keptThenFreed(attempts: string[], regions: number[]): void {
  for (const id of regions) {
    const own = attempts.filter((a) => a.startsWith(`${id} `));
    expect(own[0], `region ${id}`).toBe(`${id} kept`);
    expect(own.at(-1), `region ${id}`).toBe(`${id} freed`);
  }
}

describe.skipIf(process.platform === "win32")("lifetime regions", { timeout: 240_000 }, () => {
  test("generations free each released file and checker region once unreferenced", async () => {
    const stats = await run("5010-lifetime-region-generations.ts");
    // The module's file table still holds the last generation's files.
    expect(stats.summaries).toEqual([summary(19, 15)]);
    // A replaced file's region is kept until the checker that refers to it
    // is released.
    keptThenFreed(stats.attempts, [2, 3, 4, 1]);
  });

  test("outside references keep released regions until they are dropped", async () => {
    const stats = await run("5011-lifetime-region-outside-references.ts");
    expect(stats.summaries).toEqual([summary(7, 7)]);
    keptThenFreed(stats.attempts, [1, 2, 3, 4, 5, 6]);
    expect(stats.stdout).toContain("module variable: a1>a2>a3");
  });

  test("owned graphs of every shape and owned cycles are freed", async () => {
    for (const [program, regions] of [
      ["5012-lifetime-region-shapes.ts", 6],
      ["5017-lifetime-region-cycles.ts", 5],
      ["5018-lifetime-region-hierarchies.ts", 4],
      ["5020-lifetime-region-large.ts", 4],
    ] as const) {
      const stats = await run(program);
      expect(stats.summaries, program).toEqual([summary(regions, regions)]);
      expect(stats.attempts, program).toEqual(
        Array.from({ length: regions }, (_, i) => `${i + 1} freed`),
      );
    }
  });

  test("async work, nesting, holders the walk does not inspect and handles", async () => {
    // Objects allocated after an await live in the default region and keep
    // the regions they refer into.
    expect((await run("5013-lifetime-region-async.ts")).summaries).toEqual([summary(7, 2)]);
    const nesting = await run("5014-lifetime-region-nesting.ts");
    expect(nesting.summaries).toEqual([summary(4, 2)]);
    const opaque = await run("5021-lifetime-region-opaque-holders.ts");
    expect(opaque.summaries).toEqual([summary(2, 2)]);
    keptThenFreed(opaque.attempts, [1]);
    expect((await run("5019-lifetime-region-values.ts")).summaries).toEqual([summary(2, 0)]);
  });

  test("weak keys of freed regions do not survive", async () => {
    const stats = await run("5016-lifetime-region-weak-keys.ts");
    expect(stats.summaries).toEqual([summary(5, 4)]);
    expect(stats.stdout.split("\n").filter((l) => l.includes("fresh 50"))).toHaveLength(5);
  });

  test("published regions are pinned; worker regions belong to their threads", async () => {
    const publish = await run("5015-lifetime-region-publish.ts");
    // Main thread: the published region is pinned, the others are freed;
    // the worker frees all but its last region, still referenced at exit.
    expect(publish.summaries).toEqual([summary(3, 2), summary(3, 2, 1)].sort());
    expect(publish.attempts).toContain("1 pinned");
    const workers = await run("5022-lifetime-region-workers.ts");
    expect(workers.summaries).toEqual([summary(6, 6), summary(8, 8), summary(8, 8), summary(8, 8)]);
  });
});

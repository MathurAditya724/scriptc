/* Island object handles (scope-B NI-4) where a differential corpus program
 * cannot show it: handles to Node objects the program dropped are released,
 * so the import table does not grow with the work a program does (acyclic
 * garbage; cycles across both heaps wait for NI-8). The corpus (6812-6815)
 * pins handle semantics against Node. An island package ships with the
 * program, so the executable runs without the tree it was built from.
 * Needs a libnode pack in SCRIPTC_LIBNODE (libnode.ts). */
import { execFile } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { compile } from "@scriptc/compiler";
import { libnodePack } from "./libnode.js";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const outDir = join(repoRoot, "node_modules/.cache/scriptc-tests/node-island-handles");
const sanitize = process.env["SCRIPTC_SAN"] === "1";
const skip = libnodePack() === null;

describe.skipIf(skip)("Node island handles", () => {
  test("handles the program dropped are released", async () => {
    mkdirSync(outDir, { recursive: true });
    const result = await compile(join(repoRoot, "tests/fixtures/node-island/handles-leak.mjs"), {
      outPath: join(outDir, "handles-leak"),
      outDir,
      sanitize,
    });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const env = { ...process.env, SCRIPTC_NODE_ISLANDS_TRACE: "handles" };
    const counts: number[] = [];
    for (const n of ["2000", "20000"]) {
      const { stdout, stderr } = await execFileAsync(result.binaryPath, [n], {
        env,
        encoding: "utf8",
      });
      expect(stdout).toMatch(/^sum \d+ 499500 object -1\n$/);
      const live = /\[node-islands\] live handles (\d+)/.exec(stderr);
      expect(live).not.toBeNull();
      counts.push(Number(live![1]));
    }
    // The module and the kept object (with util.inspect, at most a few
    // more), independent of the number of iterations.
    expect(counts[0]).toBe(counts[1]);
    expect(counts[1]).toBeLessThan(8);
  }, 300_000);

  async function runFixture(name: string, entry: string): Promise<string> {
    const dir = join(outDir, name);
    mkdirSync(dir, { recursive: true });
    const result = await compile(join(repoRoot, "tests/fixtures/node-island", entry), {
      outPath: join(dir, name),
      outDir: dir,
      sanitize,
    });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const env = { ...process.env, XDG_CACHE_HOME: join(dir, "cache") };
    return (await execFileAsync(result.binaryPath, [], { env, encoding: "utf8" })).stdout;
  }

  test("island member calls and assignments evaluate in JavaScript's order", async () => {
    expect(await runFixture("order", "order/main.ts")).toBe(
      "original\nreceiver,key,value,receiver,value 1 1\n",
    );
  }, 300_000);

  test("requireModule() loads Node's built-in modules", async () => {
    expect(await runFixture("builtins", "builtins.ts")).toBe("a/b string\n");
  }, 300_000);

  test("a package marked native never runs in a Node island", async () => {
    // esmbridge's static compilation is refused, so by default it runs in a
    // Node island; marked native, the build reports the refusal instead.
    const dir = join(outDir, "native-policy");
    mkdirSync(dir, { recursive: true });
    const entry = join(repoRoot, "tests/fixtures/npm/cases/cjs-esm-named/main.ts");
    const options = { outPath: join(dir, "main"), outDir: dir, sanitize };
    const islanded = await compile(entry, options);
    expect(islanded.ok).toBe(true);
    const marked = await compile(entry, { ...options, nodeIslands: { native: ["esmbridge"] } });
    expect(marked.ok).toBe(false);
    if (!marked.ok) {
      const codes = marked.diagnostics.map((d) => d.code);
      expect(codes).toContain("SC2013");
      expect(codes).not.toContain("SC8001");
    }
  }, 300_000);

  test("an island package ships with the program", async () => {
    const root = join(outDir, "ships");
    const src = join(root, "src");
    rmSync(root, { recursive: true, force: true });
    cpSync(join(repoRoot, "tests/corpus/6816-node-island-objects"), src, { recursive: true });
    const env = { ...process.env, XDG_CACHE_HOME: join(root, "cache") };
    const built: Record<string, string> = {};
    for (const libnode of ["inside", "beside"]) {
      const dir = join(root, libnode);
      mkdirSync(dir, { recursive: true });
      const result = await compile(join(src, "main.ts"), {
        outPath: join(dir, "main"),
        outDir: dir,
        sanitize,
        ...(libnode === "beside" ? { libnode } : {}),
      });
      if (!result.ok)
        throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
      built[libnode] = result.binaryPath;
    }
    const before = await execFileAsync(built["inside"]!, [], { env, encoding: "utf8" });
    expect(before.stdout).toMatch(/^islandkit \d/);
    // The executable names its island package by its path in the shipped
    // tree, never by the directory it was built from.
    expect(readFileSync(built["inside"]!).toString("latin1").includes(src)).toBe(false);
    // Beside the executable, the tree holds the package's files.
    const index = readFileSync(join(src, "node_modules/islandkit/index.js"), "utf8");
    const modules = join(root, "beside/main.libnode/modules");
    const files = readdirSync(modules, { recursive: true, encoding: "utf8" });
    expect(
      files.some((f) => f.endsWith("index.js") && readFileSync(join(modules, f), "utf8") === index),
    ).toBe(true);
    renameSync(src, join(root, "moved"));
    for (const binary of Object.values(built)) {
      const after = await execFileAsync(binary, [], { env, encoding: "utf8" });
      expect(after.stdout).toBe(before.stdout);
    }
  }, 300_000);
});

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { analyze, compile } from "../src/index.js";

test("stored tty.isatty retains checked arguments without native-value fences", () => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-isatty-value-"));
  try {
    const entry = join(dir, "main.mjs");
    writeFileSync(
      entry,
      `
import { isatty } from "node:tty";
import * as tty from "node:tty";
const stored = isatty;
const guarded = typeof tty.isatty === "function" ? stored : () => false;
console.log(stored === tty.isatty, stored(), guarded(), stored(1n), stored("1"));
`,
    );
    const { coverage } = analyze(entry);
    expect(coverage.diagnostics).toEqual([]);
    expect(coverage.runtimeFences ?? []).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TypeScript tty.isatty aliases can escape through a callback", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-isatty-typed-value-"));
  try {
    const entry = join(dir, "main.ts");
    writeFileSync(
      entry,
      `
import { isatty } from "node:tty";
const stored = isatty;
function invoke(test: (fd: number) => boolean): boolean { return test(-1); }
console.log(stored === isatty, invoke(stored));
`,
    );
    const { coverage } = analyze(entry);
    expect(coverage.diagnostics).toEqual([]);
    expect(coverage.runtimeFences ?? []).toEqual([]);
    const result = await compile(entry, {
      optimization: "dev",
      sanitize: process.env["SCRIPTC_SAN"] === "1",
      outDir: dir,
      outPath: join(dir, "program"),
    });
    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
    if (!result.ok) return;
    const child = spawnSync(result.binaryPath, [], { encoding: "utf8" });
    expect(child.status, child.stderr).toBe(0);
    expect(child.stderr).toBe("");
    expect(child.stdout).toBe("true false\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

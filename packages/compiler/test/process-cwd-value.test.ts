import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { analyze, compile } from "../src/index.js";

test.each(["mjs", "ts"])(
  "process.cwd aliases compile as callable values (%s)",
  async (extension) => {
    const dir = mkdtempSync(join(tmpdir(), "scriptc-cwd-value-"));
    try {
      const entry = join(dir, `main.${extension}`);
      writeFileSync(
        entry,
        `
import { cwd } from "node:process";
import * as processModule from "node:process";
const stored = process.cwd;
const fromModule = processModule.cwd;
function invoke(fn${extension === "ts" ? ": () => string" : ""}) { return fn(); }
console.log(stored === cwd, fromModule === stored, invoke(stored) === process.cwd());
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
      expect(child.stdout).toBe("true true true\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

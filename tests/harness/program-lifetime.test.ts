/* `programLifetime: false` (scriptc build --program-lifetime=off) compiles
 * ProgramLifetime classes as ordinary reference-counted, cycle-collected
 * classes. The fixture builds and drops one ProgramLifetime graph per
 * generation: both modes match Node, and with the option off the dropped
 * graphs are freed, so peak memory stays near one generation instead of
 * growing with every generation. Under SCRIPTC_SAN=1 the off mode also runs
 * the RC audit, which fails the run if any instance is left unfreed. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests");
const sanitize = process.env["SCRIPTC_SAN"] === "1";
const fixture = join(repoRoot, "tests/fixtures/program-lifetime/generations.ts");
// The ProgramLifetime corpus programs, which the corpus suites build with
// the default.
const corpus = [
  "tests/corpus/4633-contract-program-lifetime.ts",
  "tests/corpus/4634-contract-program-lifetime-publish.ts",
];

async function build(file: string, programLifetime: boolean): Promise<string> {
  const mode = programLifetime ? "on" : "off";
  const key = createHash("sha256")
    .update(file)
    .update(readFileSync(file))
    .update(mode)
    .update(sanitize ? "san" : "plain")
    .digest("hex")
    .slice(0, 16);
  const outDir = join(cacheDir, `program-lifetime-${key}`);
  mkdirSync(outDir, { recursive: true });
  const result = await compile(file, {
    outPath: join(outDir, "program"),
    outDir,
    sanitize,
    backend: "llvm",
    ...(programLifetime ? {} : { programLifetime: false }),
  });
  if (!result.ok) {
    throw new Error(
      `program failed to compile (program lifetime ${mode}):\n` +
        result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"),
    );
  }
  return result.binaryPath;
}

async function run(binary: string, args: string[], programLifetime: boolean): Promise<string> {
  const mode = programLifetime ? "on" : "off";
  const result = await execFileAsync(binary, args, { maxBuffer: 16 * 1024 * 1024 });
  // The RC audit names the instances it skips; with the option off there
  // are none, and any instance left unfreed fails the audit.
  const stderr = result.stderr.replace(
    /^scriptc RC audit skipped: \d+ program-lifetime object\(s\) never freed\n/m,
    programLifetime && sanitize ? "" : "$&",
  );
  expect(stderr, `program lifetime ${mode} stderr`).toBe("");
  return result.stdout;
}

async function buildAndRun(programLifetime: boolean): Promise<{ stdout: string; rssKb: number }> {
  const mode = programLifetime ? "on" : "off";
  const stdout = await run(await build(fixture, programLifetime), ["--rss"], programLifetime);
  const lines = stdout.trimEnd().split("\n");
  const rss = /^maxRSS (\d+)$/.exec(lines.pop() ?? "");
  expect(rss, `program lifetime ${mode} reports its peak RSS`).not.toBeNull();
  return { stdout: `${lines.join("\n")}\n`, rssKb: Number(rss![1]) };
}

describe.skipIf(process.platform === "win32")("--program-lifetime=off", () => {
  test(
    "frees dropped ProgramLifetime graphs and matches Node in both modes",
    { timeout: 300_000 },
    async () => {
      const expected = await execFileAsync(process.execPath, [fixture], {
        maxBuffer: 16 * 1024 * 1024,
      });
      const [on, off] = await Promise.all([buildAndRun(true), buildAndRun(false)]);
      expect(on.stdout).toBe(expected.stdout);
      expect(off.stdout).toBe(expected.stdout);
      // About 90 MiB of retained generations by default; one generation off.
      // Sanitizer quarantine and shadow memory make RSS meaningless there;
      // the fixture reads its own high-water mark on Linux.
      if (!sanitize && process.platform === "linux") {
        expect(off.rssKb).toBeLessThan(32 * 1024);
        expect(off.rssKb * 4).toBeLessThan(on.rssKb);
      }
    },
  );

  test.each(corpus)(
    "%s matches Node with the option off",
    { timeout: 300_000 },
    async (program) => {
      const file = join(repoRoot, program);
      const expected = await execFileAsync(process.execPath, [file], {
        env: { ...process.env, SCRIPTC_TEST_ENV: "from-harness" },
        maxBuffer: 16 * 1024 * 1024,
      });
      expect(await run(await build(file, false), [], false)).toBe(expected.stdout);
    },
  );
});

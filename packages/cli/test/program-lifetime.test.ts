import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../../..");
const bootstrap = join(repoRoot, "packages/cli/dist/bootstrap.js");

// The count every program-lifetime instance is created with (2^63).
const IMMORTAL_COUNT = "store i64 -9223372036854775808";

// Builds and drops ProgramLifetime graphs; resolves @scriptc/types from the repo.
const fixture = join(repoRoot, "tests/fixtures/program-lifetime/generations.ts");

test("--program-lifetime accepts on and off and names them when rejecting", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-cli-program-lifetime-"));
  try {
    const entry = fixture;
    const env = { ...process.env, SCRIPTC_CACHE_DIR: join(dir, "cache") };
    const help = await execFileAsync(process.execPath, [bootstrap, "--help"], { env });
    expect(help.stdout).toContain("--program-lifetime <on|off>");
    for (const [args, message] of [
      [["build", entry, "--program-lifetime=never"], "(supported: on, off)"],
      [["run", entry, "--program-lifetime", "no"], "(supported: on, off)"],
      [["coverage", entry, "--program-lifetime=off"], "--program-lifetime is a build/run option"],
      [["cache", "warm", "--program-lifetime=off"], "scriptc cache warm takes only"],
      [
        ["build", "--lib", "--profile", join(dir, "p.json"), "--program-lifetime=off"],
        "--program-lifetime",
      ],
    ] as const) {
      await expect(
        execFileAsync(process.execPath, [bootstrap, ...args], { env }),
      ).rejects.toMatchObject({ stderr: expect.stringContaining(message) });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 60_000);

test("--program-lifetime=off builds never share cache entries with the default", async () => {
  const dir = await mkdtemp(
    join(process.platform === "win32" ? tmpdir() : "/tmp", "scriptc-program-lifetime-"),
  );
  try {
    const entry = fixture;
    const outPath = join(dir, process.platform === "win32" ? "program.exe" : "program");
    const llvmPath = join(dir, "generations.ll");
    const env = { ...process.env, SCRIPTC_CACHE_DIR: join(dir, "cache") };
    const build = async (mode: "on" | "off" | null): Promise<boolean> => {
      await execFileAsync(
        process.execPath,
        [
          bootstrap,
          "build",
          entry,
          "-o",
          outPath,
          ...(mode === null ? [] : [`--program-lifetime=${mode}`]),
        ],
        { env, maxBuffer: 4 * 1024 * 1024 },
      );
      expect((await execFileAsync(outPath)).stdout).toContain("done: 971498\n");
      return (await readFile(llvmPath, "utf8")).includes(IMMORTAL_COUNT);
    };
    // Each build after the first two can be served from the cache; every
    // one must still match its own mode.
    expect(await build(null)).toBe(true);
    expect(await build("off")).toBe(false);
    expect(await build("on")).toBe(true);
    expect(await build("off")).toBe(false);
    expect(await build(null)).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 180_000);

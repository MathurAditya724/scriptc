import { execFile } from "node:child_process";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const testDir = import.meta.dirname;
const srcDir = join(testDir, "../src");
const vendorDir = join(testDir, "../vendor");
const buildDir = join(testDir, "build", "common-symbols");

// Library localization (abi.localize_runtime) keeps COMMON symbols global,
// so a runtime global written as a tentative definition (`T x;` at file
// scope with no initializer) is exported from every localized library
// archive on toolchains that emit tentative definitions as COMMON symbols,
// such as the macOS runtime build. Linux clang defaults to -fno-common, where
// the same declaration is an ordinary definition, so the library-multi
// symbol checks only catch it on macOS. This test compiles every runtime
// source with -fcommon, in the plain and worker configurations, and expects
// no COMMON symbols: every external runtime global needs an initializer.
test("runtime globals are not tentative definitions", async () => {
  await mkdir(buildDir, { recursive: true });
  const sources = (await readdir(srcDir))
    .filter((name) => name.endsWith(".c") && !name.endsWith(".test.c"))
    .sort();
  const jobs = sources.flatMap((name) =>
    [[], ["-DSCR_WORKERS"]].map((defines) => ({ name, defines })),
  );
  const common: string[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < jobs.length) {
      const { name, defines } = jobs[next++]!;
      const output = join(buildDir, `${name}${defines.join("")}.ll`);
      await execFileAsync("clang", [
        "-std=c11",
        "-O0",
        "-fcommon",
        "-S",
        "-emit-llvm",
        ...(process.platform === "linux" ? ["-D_GNU_SOURCE"] : []),
        ...defines,
        `-I${join(vendorDir, "quickjs-ng")}`,
        `-I${join(vendorDir, "mbedtls", "include")}`,
        "-o",
        output,
        join(srcDir, name),
      ]);
      for (const match of (await readFile(output, "utf8")).matchAll(/^@(\S+) = common /gm)) {
        common.push(`${name}${defines.length > 0 ? ` (${defines.join(" ")})` : ""}: ${match[1]}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, availableParallelism()) }, worker));
  expect(common.sort()).toEqual([]);
});

import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const testDir = import.meta.dirname;

// scr_unwind.c walks with cached plans on x86-64 Linux only.
test.runIf(process.platform === "linux" && process.arch === "x64")(
  "the unwinder runs landing pads in order, restores callee-saved registers and falls back to libgcc",
  async () => {
    const buildDir = join(testDir, "build");
    await mkdir(buildDir, { recursive: true });
    const frames = [join(testDir, "test_unwind_frames.ll"), join(testDir, "test_unwind_frames.S")];
    // The frames also run from a shared library, whose FDEs are in its own
    // .eh_frame_hdr.
    const library = join(buildDir, "libtest_unwind_frames.so");
    await execFileAsync("clang", ["-O1", "-shared", "-fPIC", "-o", library, ...frames]);
    for (const build of ["plain", "asan", "shared"] as const) {
      const bin = join(buildDir, `test_unwind_${build}`);
      await execFileAsync("clang", [
        "-std=c11",
        "-O1",
        "-Wall",
        "-Wextra",
        "-D_GNU_SOURCE",
        "-DSCR_UNWIND_TESTING",
        ...(build === "asan" ? ["-fsanitize=address"] : []),
        "-pthread",
        "-o",
        bin,
        join(testDir, "test_unwind.c"),
        ...(build === "shared" ? [library, `-Wl,-rpath,${buildDir}`] : frames),
        join(testDir, "../src/scr_unwind.c"),
        // The library's landing pads and the program share libgcc_s's unwinder.
        ...(build === "shared" ? ["-shared-libgcc"] : ["-lgcc_eh"]),
      ]);
      const env = { ...process.env, ASAN_OPTIONS: "detect_leaks=0:halt_on_error=1" };
      for (const args of [[], ["threads"]]) {
        const run = await execFileAsync(bin, args, { env });
        expect(run.stdout).toBe("unwind checks passed\n");
      }
    }
  },
  120_000,
);

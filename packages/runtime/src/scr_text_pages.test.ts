import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const exec = promisify(execFile);

/* The code-page move links alone (it needs only libc). Whether it moves the
 * code depends on the system's transparent huge page mode. */
test.skipIf(process.platform !== "linux")(
  "an opted-in program's code moves onto huge pages when the system allows them",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-text-pages-"));
    try {
      const bin = join(dir, "text-pages");
      await exec("clang", [
        "-std=c11",
        "-O1",
        "-Wall",
        "-Wextra",
        "-D_GNU_SOURCE",
        "-fsanitize=undefined",
        join(import.meta.dirname, "scr_text_pages.test.c"),
        join(import.meta.dirname, "scr_text_pages.c"),
        "-o",
        bin,
      ]);
      const mode = await readFile("/sys/kernel/mm/transparent_hugepage/enabled", "utf8").catch(
        () => "",
      );
      const allowed = mode.includes("[always]") || mode.includes("[madvise]");
      const result = await exec(bin, [], {
        env: { ...process.env, UBSAN_OPTIONS: "halt_on_error=1" },
      });
      expect(result.stdout).toBe(`text page checks passed: ${allowed ? "moved" : "kept"}\n`);
      expect(result.stderr).toBe("");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

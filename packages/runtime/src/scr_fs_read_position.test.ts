import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { EXECUTABLE_RUNTIME_SOURCES } from "../../compiler/src/backend/native-toolchain.js";

const exec = promisify(execFile);

test.skipIf(process.platform === "win32")(
  "BigInt read positions reach pread without rounding",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-fs-read-position-"));
    try {
      const binary = join(dir, "read-position");
      await exec("clang", [
        "-std=c11",
        "-O1",
        "-pthread",
        "-fsanitize=address,undefined",
        "-Wno-deprecated-declarations",
        ...(process.platform === "linux" ? ["-D_GNU_SOURCE"] : []),
        ...["scr_fs_read_position.test.c", ...EXECUTABLE_RUNTIME_SOURCES].map((name) =>
          join(import.meta.dirname, name),
        ),
        ...(process.platform === "linux" ? ["-lm"] : []),
        "-o",
        binary,
      ]);
      const result = await exec(binary, [], {
        env: {
          ...process.env,
          ASAN_OPTIONS: "detect_leaks=0:halt_on_error=1",
          UBSAN_OPTIONS: "halt_on_error=1",
        },
      });
      expect(result.stdout).toBe("BigInt read positions reach the OS without rounding\n");
      expect(result.stderr).toBe("");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  120_000,
);

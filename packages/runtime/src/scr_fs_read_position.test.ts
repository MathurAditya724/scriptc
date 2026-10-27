import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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

// The Number entry already performed the kernel read inline. Sharing its
// implementation with the BigInt entry must not add a helper transition.
test.skipIf(process.platform === "win32")(
  "Number read entry keeps the kernel operations inline at O2",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-fs-read-emission-"));
    try {
      const output = join(dir, "read.ll");
      await exec("clang", [
        "-std=c11",
        "-O2",
        "-pthread",
        "-fno-math-errno",
        "-fno-strict-aliasing",
        "-Wno-deprecated-declarations",
        "-S",
        "-emit-llvm",
        ...(process.platform === "linux" ? ["-D_GNU_SOURCE"] : []),
        join(import.meta.dirname, "scr_lib.c"),
        "-o",
        output,
      ]);
      const llvm = await readFile(output, "utf8");
      const body = llvm.match(/^define [^\n]*@scr_fs_read_sync\([^\n]*\n([\s\S]*?)^}/m)?.[1];
      expect(body).toBeDefined();
      expect(body).toMatch(/\bcall\b[^\n]*@(?:read|"\\01_read")\(/);
      expect(body).toMatch(/\bcall\b[^\n]*@(?:pread|"\\01_pread")\(/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  30_000,
);

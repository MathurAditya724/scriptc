import { execFile } from "node:child_process";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeAll, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const testDir = import.meta.dirname;
const bin = join(testDir, "build", "test_cipher_kernels");
const mbedtls = join(testDir, "../vendor/mbedtls");

// Compiles the cipher kernels with the vendored mbedTLS library, under
// ASan, once.
beforeAll(async () => {
  await mkdir(join(testDir, "build"), { recursive: true });
  const library = (await readdir(join(mbedtls, "library")))
    .filter((name) => name.endsWith(".c"))
    .sort()
    .map((name) => join(mbedtls, "library", name));
  await execFileAsync("clang", [
    "-std=c11",
    "-O1",
    "-fsanitize=address",
    "-I",
    join(testDir, "../src"),
    "-I",
    join(mbedtls, "include"),
    "-I",
    join(mbedtls, "library"),
    "-o",
    bin,
    join(testDir, "test_cipher_kernels.c"),
    join(testDir, "../src/scr_cipher_simd.c"),
    ...library,
  ]);
}, 300_000);

// Runs against the committed case file (generated from Node v24 by
// gen-cipher-cases.mjs). On x86-64 CPUs with AES-NI, PCLMULQDQ and AVX2,
// every case also runs through the SIMD kernels with several chunkings.
test("cipher kernels match Node on committed cases", async () => {
  const { stderr } = await execFileAsync(bin, [join(testDir, "cipher-cases.txt")]);
  expect(stderr.trim()).toMatch(/^cases 500 simd \d+ failures 0$/);
});

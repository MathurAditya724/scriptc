import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { compileLibArchive } from "./library.js";

const available = (name: string): boolean =>
  (process.env["PATH"] ?? "")
    .split(delimiter)
    .some((entry) => existsSync(join(entry || ".", name)));
const sourceLibraryTest = test.skipIf(
  process.platform === "win32" ||
    process.env["SCRIPTC_PORTABLE_ONLY"] === "1" ||
    !available("clang") ||
    !available("ar"),
);

let directory: string;
let cPath: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "scriptc-borrowed-set-library-"));
  cPath = join(directory, "probe.c");
  await writeFile(cPath, "void borrowed_set_library_probe(void) {}\n");
});

afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

sourceLibraryTest.each([
  { dynInvoke: false, dynTier: false },
  { dynInvoke: true, dynTier: false },
  { dynInvoke: false, dynTier: true },
  { dynInvoke: true, dynTier: true },
])(
  "source library selects optional units for dynInvoke=$dynInvoke and dynTier=$dynTier",
  async ({ dynInvoke, dynTier }) => {
    const outPath = join(directory, `probe-${dynInvoke}-${dynTier}.a`);
    await compileLibArchive({ cPath, outPath, dynInvoke, dynTier, sanitize: true });
    const archive = await readFile(outPath);
    expect(archive.includes(Buffer.from("scr_dyn_typed_array_proto_set"))).toBe(dynInvoke);
    expect(archive.includes(Buffer.from("scr_js_load_probe"))).toBe(dynTier);
  },
);

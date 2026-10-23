/* The declaration-typed boundary's checks (decl-projection.ts): a value
 * zod's declarations type wrongly fails the boundary cast with a TypeError
 * naming the path, and a value the native record cannot represent (a
 * frozen object) fails with the reason. Node does not check, so this is a
 * native-only test; npm.test.ts runs the differential cases
 * (zod3-boundary, zod3-adoption, zod3-infer). */
import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const entry = join(repoRoot, "tests/fixtures/npm/cases/zod3-boundary/lying.ts");
const outDir = join(repoRoot, "node_modules/.cache/scriptc-tests/decl-boundary");
const sanitize = process.env["SCRIPTC_SAN"] === "1";

test("boundary casts throw a path TypeError for values the declarations misdescribe", { timeout: 600_000 }, async () => {
  mkdirSync(outDir, { recursive: true });
  const result = await compile(entry, { outPath: join(outDir, "lying"), outDir, sanitize });
  if (!result.ok) {
    throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
  }
  const pending = execFileAsync(result.binaryPath, [], { cwd: dirname(entry), encoding: "utf8" });
  pending.child.stdin?.end();
  const { stdout } = await pending;
  expect(stdout).toBe(
    "liar threw true expected number at $.n, got string\n" +
      "frozen threw expected a plain object (this value is frozen, sealed or not extensible) at $, got object\n",
  );
});

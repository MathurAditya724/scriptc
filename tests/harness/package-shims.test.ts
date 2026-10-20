/* Package shims (packages/compiler/src/frontend/package-shims.ts) beyond the
 * npm differential cases that run them against Node:
 *
 * - a package the project marks unloaded stays unloaded when it IS
 *   installed: the native program prints what Node prints without the
 *   package, and the package's code never runs;
 * - a shimmed package that is not installed, or whose major version has no
 *   shim, resolves exactly as before (here: refused like any missing or
 *   uncompiled package);
 * - a CommonJS package's require() of a shimmed package (fs-extra, required
 *   by an installed package's JavaScript) compiles the shim, and matches
 *   Node running the real package.
 */
import { execFile } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const casesRoot = join(repoRoot, "tests/fixtures/npm/cases");
const fsExtraModules = join(repoRoot, "tests/corpus/fs-extra-package/node_modules");
const sanitize = process.env["SCRIPTC_SAN"] === "1";
const scratch = mkdtempSync(join(tmpdir(), "scriptc-package-shims-"));

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

async function run(cmd: string, args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync(cmd, args, { cwd, encoding: "utf8" });
  return stdout;
}

/** A copy of an npm fixture case in the scratch directory. */
function copyCase(name: string, as: string): string {
  const dir = join(scratch, as);
  cpSync(join(casesRoot, name), dir, { recursive: true });
  return dir;
}

function installEncoding(dir: string): void {
  const pkg = join(dir, "node_modules/encoding");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(
    join(pkg, "package.json"),
    '{ "name": "encoding", "version": "0.1.13", "main": "index.js" }\n',
  );
  writeFileSync(
    join(pkg, "index.js"),
    "'use strict';\nconsole.log('encoding loaded');\nexports.convert = (text) => Buffer.from(String(text));\n",
  );
}

describe("package shims", () => {
  test("an unloaded package is never loaded, even when installed", async () => {
    const original = join(casesRoot, "unloaded-optional-dependency");
    const expected = await run(process.execPath, [join(original, "main.ts")], original);
    expect(expected).toContain("MODULE_NOT_FOUND: Cannot find module 'encoding'");

    const dir = copyCase("unloaded-optional-dependency", "unloaded-installed");
    installEncoding(dir);
    // Control: Node loads the installed package.
    expect(await run(process.execPath, [join(dir, "main.ts")], dir)).toContain("encoding loaded");

    const out = join(dir, ".scriptc");
    const result = await compile(join(dir, "main.ts"), {
      outPath: join(out, "program"),
      outDir: out,
      sanitize,
    });
    if (!result.ok) throw new Error(result.diagnostics.map((d) => d.message).join("\n"));
    expect(await run(result.binaryPath, [], dir)).toBe(expected);
  }, 180_000);

  test("a CommonJS package requiring fs-extra compiles the shim", async () => {
    const dir = join(scratch, "fs-extra-require");
    cpSync(fsExtraModules, join(dir, "node_modules"), { recursive: true });
    const pkg = join(dir, "node_modules/fxuser");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(
      join(pkg, "package.json"),
      '{ "name": "fxuser", "version": "1.0.0", "main": "index.js", "types": "index.d.ts" }\n',
    );
    writeFileSync(
      join(pkg, "index.js"),
      [
        "'use strict';",
        "const fs = require('fs-extra');",
        "exports.exists = function (p) { return fs.pathExistsSync(p); };",
        "exports.read = function (p) { return fs.readFile(p, 'utf8'); };",
        "exports.write = async function (p, obj) { await fs.outputJson(p, obj); return fs.readJsonSync(p); };",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(pkg, "index.d.ts"),
      [
        "export declare function exists(p: string): boolean;",
        "export declare function read(p: string): Promise<string>;",
        "export declare function write(p: string, obj: unknown): Promise<unknown>;",
        "",
      ].join("\n"),
    );
    writeFileSync(join(dir, "data.txt"), "data\n");
    writeFileSync(
      join(dir, "main.ts"),
      [
        'import { exists, read, write } from "fxuser";',
        "async function main(): Promise<void> {",
        '  console.log(exists("data.txt"), exists("missing.txt"));',
        '  console.log(JSON.stringify(await read("data.txt")));',
        '  console.log(JSON.stringify(await write("out/nested/a.json", { a: [1] })));',
        "}",
        "main();",
        "",
      ].join("\n"),
    );
    const expected = await run(process.execPath, [join(dir, "main.ts")], dir);
    rmSync(join(dir, "out"), { recursive: true, force: true });
    const result = await compile(join(dir, "main.ts"), {
      outPath: join(dir, ".scriptc/program"),
      outDir: join(dir, ".scriptc"),
      sanitize,
    });
    if (!result.ok) throw new Error(result.diagnostics.map((d) => d.message).join("\n"));
    expect(await run(result.binaryPath, [], dir)).toBe(expected);
  }, 180_000);

  test("a shimmed package that is not installed is not shimmed", async () => {
    const dir = join(scratch, "undici-missing");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "main.ts"),
      'import { request } from "undici";\nconsole.log(typeof request);\n',
    );
    const result = await compile(join(dir, "main.ts"), {
      outPath: join(dir, ".scriptc/program"),
      outDir: join(dir, ".scriptc"),
      sanitize,
    });
    expect(result.ok).toBe(false);
  }, 180_000);

  test("an unsupported major version is not shimmed", async () => {
    const dir = join(scratch, "undici-v6");
    const pkg = join(dir, "node_modules/undici");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(
      join(pkg, "package.json"),
      '{ "name": "undici", "version": "6.21.0", "main": "index.js", "types": "index.d.ts" }\n',
    );
    writeFileSync(join(pkg, "index.js"), "exports.version = 6;\n");
    writeFileSync(join(pkg, "index.d.ts"), "export declare const version: number;\n");
    writeFileSync(
      join(dir, "main.ts"),
      'import { version } from "undici";\nconsole.log(version);\n',
    );
    const result = await compile(join(dir, "main.ts"), {
      outPath: join(dir, ".scriptc/program"),
      outDir: join(dir, ".scriptc"),
      sanitize,
    });
    // The package's own declarations type the import (no shim exports
    // `version`); whatever the npm compile then decides, it is not the shim.
    if (result.ok) {
      expect(await run(result.binaryPath, [], dir)).toBe("6\n");
    } else {
      expect(result.diagnostics.map((d) => d.message).join("\n")).not.toContain("shims/undici");
    }
  }, 180_000);
});

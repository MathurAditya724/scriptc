import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { nodeFrontendServices } from "./services-node.js";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function rewrite(source: string): string | null {
  return nodeFrontendServices().cjsFunctionExports(source, "/pkg/index.js");
}

function run(file: string) {
  const result = spawnSync(process.execPath, [file], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** The rewritten module prints what the original prints. */
function expectSameBehavior(source: string): string {
  const result = rewrite(source);
  expect(typeof result).toBe("string");
  const dir = mkdtempSync(join(tmpdir(), "scriptc-cjs-function-exports-"));
  dirs.push(dir);
  const original = join(dir, "original.cjs");
  const rewritten = join(dir, "rewritten.cjs");
  writeFileSync(original, source);
  writeFileSync(rewritten, result as string);
  const oracle = run(original);
  expect(oracle.status).toBe(0);
  expect(run(rewritten)).toEqual(oracle);
  return result as string;
}

const report = `
console.log(typeof module.exports, module.exports === Version, Object.keys(Version).join(","));
`;

test("members of a function export object read and write the function", () => {
  const rewritten = expectSameBehavior(`exports = module.exports = Version;
exports.parse = parse;
module.exports.major = (v) => parse(v)[0];
function Version(v) { return { v }; }
function parse(v) { return v.split(".").map(Number); }
console.log(exports.major("2.1.0"), module.exports.parse("1.2").length);
${report}`);
  expect(rewritten).toContain("Version.parse = parse");
  expect(rewritten).not.toContain("exports = module.exports");
});

test.each([
  ["a parameter", "function inner(Version) { return exports.parse; }"],
  ["a local", "function inner() { const Version = {}; return exports.parse; }"],
  ["a nested function", "function inner() { function Version() {} return exports.parse; }"],
  [
    "a catch binding",
    "function inner() { try { throw 0; } catch (Version) { return exports.parse; } }",
  ],
])("a nested binding of the function's name (%s) keeps the module as it is", (_, inner) => {
  expect(
    rewrite(`exports = module.exports = Version;
exports.parse = parse;
function Version() {}
function parse() {}
${inner}
`),
  ).toBeNull();
});

test("an `exports` shorthand property keeps its key", () => {
  const rewritten = expectSameBehavior(`exports = module.exports = Version;
exports.tag = "v";
function Version() {}
const holder = { exports };
console.log(Object.keys(holder).join(","), holder.exports === Version, holder.exports.tag);
${report}`);
  expect(rewritten).toContain("{ exports: Version }");
});

test("a var or const bound to a function is a function export too", () => {
  // esbuild's hoisted spelling of a bundled module's top-level const,
  // below the bundle's require bindings.
  const viaVar = expectSameBehavior(`"use strict";
var path = require("path");
var Version = (v) => ({ v, base: path.basename(v) });
module.exports = Version;
module.exports.default = Version;
module.exports.object = (v) => ({ value: v });
console.log(module.exports.object(1).value, module.exports.default === Version);
${report}`);
  expect(viaVar).toContain("Version.object = ");
  const viaConst = expectSameBehavior(`const Version = function (v) { return { v }; };
module.exports = Version;
module.exports.tag = "t";
${report}`);
  expect(viaConst).toContain('Version.tag = "t"');
});

test.each([
  ["a let binding", `let Version = () => 1;\nmodule.exports = Version;\nmodule.exports.x = 1;\n`],
  [
    "a reassigned var",
    `var Version = () => 1;\nmodule.exports = Version;\nmodule.exports.x = 1;\nVersion = () => 2;\n`,
  ],
  [
    "a var below the export",
    `module.exports = Version;\nmodule.exports.x = 1;\nvar Version = () => 1;\n`,
  ],
  [
    "a call above the export",
    `var Version = () => 1;\nconsole.log("early");\nmodule.exports = Version;\nmodule.exports.x = 1;\n`,
  ],
])("%s keeps the module as it is", (_, source) => {
  expect(rewrite(source)).toBeNull();
});

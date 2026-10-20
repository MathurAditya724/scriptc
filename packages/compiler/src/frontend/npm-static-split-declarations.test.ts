import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { nodeFrontendServices } from "./services-node.js";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function rewrite(source: string): string | null {
  return nodeFrontendServices().splitRequireDeclarations(source, "/pkg/index.js");
}

const lib = `"use strict";
function Minimatch(p) { this.p = p; }
Minimatch.prototype.show = function () { return "mm:" + this.p; };
module.exports = function minimatch(p) { return new Minimatch(p).show(); };
module.exports.Minimatch = Minimatch;
`;

/** The rewritten module prints what the original prints. */
function expectSameBehavior(source: string): string {
  const result = rewrite(source);
  expect(typeof result).toBe("string");
  const dir = mkdtempSync(join(tmpdir(), "scriptc-split-declarations-"));
  dirs.push(dir);
  mkdirSync(join(dir, "lib"));
  writeFileSync(join(dir, "lib", "index.js"), lib);
  writeFileSync(join(dir, "original.cjs"), source);
  writeFileSync(join(dir, "rewritten.cjs"), result!);
  const run = (file: string) =>
    spawnSync(process.execPath, [join(dir, file)], { encoding: "utf8" });
  const oracle = run("original.cjs");
  expect(oracle.status).toBe(0);
  expect(run("rewritten.cjs").stdout).toBe(oracle.stdout);
  expect(result!.split("\n").length).toBe(source.split("\n").length);
  return result!;
}

test("a minified declaration of requires and bindings read from them splits per binding", () => {
  const out = expectSameBehavior(`"use strict";
var path = require("path"), lib = require("./lib/index.js"), Minimatch = lib.Minimatch, sep = path.sep;
console.log(new Minimatch("a").show(), lib("b"), sep);
`);
  expect(out).toContain(
    'var path = require("path"); var lib = require("./lib/index.js"); var Minimatch = lib.Minimatch; var sep = path.sep;',
  );
});

test("const declarations and a require in the last declarator split too", () => {
  const out = expectSameBehavior(`const n = 1,
  lib = require("./lib/index.js");
console.log(n, lib("c"));
`);
  expect(out).toContain("const n = 1; const \n");
});

test("declarations without requires, nested ones and single declarators stay", () => {
  expect(rewrite(`var a = 1, b = 2;\nvar c = require("x");\n`)).toBeNull();
  expect(
    rewrite(`function f() { var a = require("x"), b = a.y; return b; }\nmodule.exports = f;\n`),
  ).toBeNull();
});

test("a declarator that also stores an export becomes the declaration and the export", () => {
  // semver 6's spelling, merged by a minifier.
  const out = expectSameBehavior(`"use strict";
var re = exports.re = [], t = module.exports.tokens = {}, R = 0;
function tok(n) { t[n] = R++; }
tok("A"); tok("B");
re[t.B] = "b";
console.log(JSON.stringify(exports.tokens), exports.re.length, t === exports.tokens);
`);
  expect(out).toContain(
    "var re = []; exports.re = re; var t = {}; module.exports.tokens = t; var R = 0;",
  );
});

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { nodeFrontendServices } from "./services-node.js";
import { rewriteBundlerCjsExports } from "./npm-static-rewrite.js";
import type { BundledChunkSplit } from "./npm-static-bundled-chunks.js";

const keyedHelper = `var __getOwnPropNames = Object.getOwnPropertyNames;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
`;

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function split(source: string, file = "/pkg/dist/index.js") {
  return nodeFrontendServices().splitCjsChunks(source, file);
}

function run(file: string) {
  const result = spawnSync(process.execPath, [file], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Runs the original bundle and its split modules side by side. */
function expectSameBehavior(source: string): BundledChunkSplit {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-chunks-"));
  dirs.push(dir);
  const original = join(dir, "original.js");
  writeFileSync(original, source);
  const bundle = join(dir, "index.js");
  const result = split(source, bundle);
  expect(result).not.toBeNull();
  expect(result).not.toHaveProperty("degrade");
  const answer = result as BundledChunkSplit;
  writeFileSync(bundle, answer.text);
  for (const chunk of answer.chunks) writeFileSync(chunk.path, chunk.source);
  // Respelled calls and blanked declarations keep the line structure.
  expect(answer.text.split("\n")).toHaveLength(source.split("\n").length);
  const oracle = run(original);
  expect(oracle.status).toBe(0);
  expect(run(bundle)).toEqual(oracle);
  return answer;
}

test("chunks run once, at their first require, with shared module instances", () => {
  const answer = expectSameBehavior(`"use strict";
${keyedHelper}
var require_b = __commonJS({
  "b.js"(exports2, module2) {
    console.log("b init");
    module2.exports = { n: 1 };
  }
});
var require_a = __commonJS({
  "a.js"(exports2) {
    console.log("a init");
    var b = require_b();
    exports2.value = b.n + 1;
    exports2.keys = Object.keys({ exports2 });
  }
});
console.log("start");
console.log(require_a().value, require_a().value, require_b().n, require_a().keys);
`);
  expect(answer.chunks.map((c) => basename(c.path))).toEqual([
    "index.js.require_b.cjs",
    "index.js.require_a.cjs",
  ]);
  expect(answer.text).not.toContain("require_a()");
});

test("the arrow helper form and minified spellings split the same way", () => {
  expectSameBehavior(
    `var __commonJS=(cb,mod)=>()=>(mod||cb((mod={exports:{}}).exports,mod),mod.exports);` +
      `var require_x=__commonJS((exports,module)=>{module.exports={v:"x"}});` +
      `console.log(require_x().v,require_x()===require_x());`,
  );
});

test("esbuild 0.11's Object.keys spelling is recognized", () => {
  expectSameBehavior(`var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[Object.keys(cb)[0]])((mod = {exports: {}}).exports, mod), mod.exports;
};
var require_y = __commonJS({
  "y.js"(exports) {
    exports.y = 3;
  }
});
console.log(require_y().y);
`);
});

test("pure helpers a chunk reads travel with it", () => {
  const answer = expectSameBehavior(`${keyedHelper}var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });
var require_named = __commonJS({
  "named.js"(exports2, module2) {
    module2.exports = __name(function () {}, "renamed");
  }
});
console.log(require_named().name);
`);
  const chunk = answer.chunks[0]!.source;
  expect(chunk).toContain("var __name =");
  expect(chunk).toContain("var __defProp = Object.defineProperty;");
});

test.each([
  ["reads its factory's receiver", `console.log(this);`],
  ["reads its factory's arguments object", `console.log(arguments.length);`],
  ["returns from its top level", `if (exports2) return;`],
  ["uses its module object beyond module.exports", `console.log(module2.id);`],
  ["reads __filename", `console.log(__filename);`],
  ["rebinds its module parameters", `function f(module2) { return module2; }`],
  ["reads the bundle's top-level binding 'state'", `console.log(state);`],
])("a chunk that %s keeps the package refused", (reason, statement) => {
  const result = split(`${keyedHelper}var state = { n: 1 };
var require_c = __commonJS({
  "c.js"(exports2, module2) {
    ${statement}
  }
});
require_c();
`);
  expect(result).toEqual({ degrade: expect.stringContaining(reason) as string });
});

test("a factory used other than as a direct call keeps the package refused", () => {
  const result =
    split(`${keyedHelper}var require_d = __commonJS({ "d.js"(exports2) { exports2.d = 1; } });
var load = require_d;
load();
`);
  expect(result).toEqual({
    degrade: expect.stringContaining("used other than as a direct call") as string,
  });
});

test("an unrecognized helper body keeps the package refused", () => {
  const result =
    split(`var __commonJS = (cb, mod) => () => (mod || cb((mod = { exports: {} }).exports, mod), mod);
var require_e = __commonJS((exports) => { exports.e = 1; });
require_e();
`);
  expect(result).toEqual({ degrade: expect.stringContaining("__commonJS helper") as string });
});

test("files without chunks and ES-module bundles are left alone", () => {
  expect(split("exports.x = 1;\n")).toBeNull();
  expect(
    split(`${keyedHelper}var require_f = __commonJS({ "f.js"(e) { e.f = 1; } });
export default require_f();
`),
  ).toBeNull();
});

test("an identifier-minified bundle names its lost helper names", () => {
  // esbuild --minify output: the helper shapes survive, their names do not.
  const result = split(
    `var c=(r,e)=>()=>(e||r((e={exports:{}}).exports,e),e.exports);` +
      `var x=c((t,m)=>{m.exports={v:1}});console.log(x().v);`,
  );
  expect(result).toEqual({ degrade: expect.stringContaining("identifier-minified") as string });
});

test("an ES-module bundle of CommonJS chunks names the chunk interop", () => {
  const result = rewriteBundlerCjsExports(
    `${keyedHelper}var __toESM = (mod) => mod;
var require_g = __commonJS({ "g.js"(exports) { exports.g = 1; } });
var import_g = __toESM(require_g());
export const g = import_g.g;
`,
    "/pkg/dist/index.js",
  );
  expect(result).toEqual({
    degrade: expect.stringContaining("bundled CommonJS modules") as string,
  });
});

test("a chunk that only re-exports a builtin module becomes that module", () => {
  const answer = expectSameBehavior(`${keyedHelper}var require_stream = __commonJS({
  "lib/stream.js"(exports2, module2) {
    module2.exports = require("stream");
  }
});
var require_user = __commonJS({
  "lib/user.js"(exports2) {
    var Stream = require_stream();
    exports2.same = Stream === require("stream");
  }
});
console.log(typeof require_stream().PassThrough, require_user().same);
`);
  expect(answer.chunks.map((c) => basename(c.path))).toEqual(["index.js.require_user.cjs"]);
  expect(answer.text).toContain('typeof require("stream").PassThrough');
});

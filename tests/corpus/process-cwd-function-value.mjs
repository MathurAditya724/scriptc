import { cwd } from "node:process";
import * as processModule from "node:process";
import defaultProcess from "node:process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const stored = process.cwd;
const moduleValue = processModule.cwd;
const named = cwd;
const fromDefault = defaultProcess.cwd;
const require = createRequire(import.meta.url);
const fromRequire = require("node:process").cwd;
console.log(typeof stored, stored.name, stored.length);
console.log(stored === process.cwd, stored === cwd, moduleValue === cwd);
console.log(named === stored, fromDefault === stored, named.name, fromDefault.name);
console.log(process.cwd.name, cwd.name, processModule.cwd.name);
console.log(fromRequire === stored, fromRequire.name, fromRequire.length);
console.log(stored() === process.cwd());
let effects = "";
console.log(stored((effects += "extra")) === cwd(), effects);
function invoke(fn) { return fn(); }
console.log(invoke(stored) === process.cwd());
const guarded = typeof process.cwd === "function" ? process.cwd : () => "missing";
console.log(guarded() === process.cwd());
let mutable = process.cwd;
mutable = () => "replacement";
console.log(mutable(), stored() === cwd());
function shadow(process) { const get = process.cwd; return get(); }
console.log(shadow({ cwd() { return "local"; } }));

const original = process.cwd();
const directory = mkdtempSync(join(tmpdir(), "scriptc-cwd-value-"));
try {
  process.chdir(directory);
  console.log(stored() === process.cwd(), cwd() === process.cwd(), stored() !== original);
} finally {
  process.chdir(original);
  rmSync(directory, { recursive: true, force: true });
}

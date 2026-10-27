import { isatty } from "node:tty";
import * as tty from "node:tty";
import ttyDefault from "node:tty";
import { createRequire } from "node:module";

const stored = isatty;
const namespaced = tty.isatty;
console.log(typeof stored, stored === isatty, stored === namespaced);
const require = createRequire(import.meta.url);
const required = require("node:tty").isatty;
console.log(stored === ttyDefault.isatty, stored === required, required(-1));
const identities = new Set();
identities.add(stored);
console.log(stored.name, stored.length, identities.has(namespaced));
console.log(stored(0) === isatty(0), namespaced(1) === isatty(1), stored(2) === isatty(2));

let coercions = 0;
const object = { valueOf() { coercions++; return 1; } };
for (const value of [undefined, null, true, "1", 1n, Symbol("fd"), object, [], -1, 1.5, NaN, Infinity, 2 ** 31]) {
  console.log(stored(value));
}
console.log(stored(), coercions);
console.log(stored.call(null, -1), stored.apply({}, ["1"]));
const bound = stored.bind({ ignored: true });
console.log(bound(-1), bound.name, bound.length);
const callback = typeof tty.isatty === "function" ? stored : () => false;
console.log(callback(null));
let effects = 0;
console.log(stored(-1, effects++), effects);
let mutable = stored;
mutable = () => "replacement";
console.log(mutable(), stored(-1));
function shadow(tty) { const fn = tty.isatty; return fn("local"); }
console.log(shadow({ isatty(value) { return value + "!"; } }));

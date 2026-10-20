// Unmapped `arguments` functions as first-class values: called directly,
// through another module's exports, from arrays and records, and through a
// reassigned binding. Their definitions and their types as values take the
// same hidden arguments parameter.
const lib = require("./lib.cjs");
const { show, count, strict } = require("./lib.cjs");
function local(a = 0) {
  const args = arguments;
  return "local " + args.length;
}
const fromArray = [local, show][1];
const table = { local, show };
let pick = local;
pick = function (b = 3) {
  const all = arguments;
  return "picked " + all.length;
};
function apply(fn, v) {
  return fn(v);
}
console.log(lib.show(7), show(5, 6), count(), count(1, 2, 3), strict(4, 5));
console.log(fromArray(9), table.local(1, 2), table.show(), pick(1, 2, 3));
console.log(apply(show, 8), apply(lib.count, 4), apply(local, 2));
console.log([10, 20].map((x) => show(x)).join(","));

// The JavaScript consumer of static-objects-order
// (tests/harness/static-objects-order.test.ts compiles it with the shape overlay on).
const receivers = require("static-objects-order/receivers.js");
const lazy = require("static-objects-order/lazy-user.js");
const vec = require("static-objects-order/vec-user.js");

console.log("start");
console.log(receivers.ns.run("add"), receivers.ns.run("sub"), receivers.ns.reads());
console.log(lazy.greet("a"), lazy.greet("b"));
console.log(vec.len2(3, 4));

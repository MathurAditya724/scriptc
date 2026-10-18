// @deferred-fences: 9
// Function expressions lowered speculatively — the `.call(this)` and
// `.apply` receivers of CommonJS wrappers, and a computed class base — keep
// every statement of their bodies. A statement with no static lowering
// (here `module.exports` read as a value) compiles to its runtime fence
// instead of vanishing; these never run, so the binary matches Node.
// Coverage counts the three fenced statements nine times: each lowering of
// a wrapper body counts its statements, and the `.call` and `.apply`
// wrapper bodies are each lowered four times.
const verbose = process.argv.length > 99;
(function () {
  var root = this;
  console.log("call wrapper");
  if (verbose) console.log(root === module.exports);
  console.log("call wrapper done");
}).call(this);
(function (label) {
  console.log("apply wrapper", label);
  if (verbose) console.log(typeof module.exports);
}).apply(null, ["ok"]);
class Base {
  hello() {
    return "hello";
  }
}
class Derived extends (function () {
  if (verbose) console.log(module.exports);
  return Base;
})() {}
console.log(new Derived().hello());

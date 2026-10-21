"use strict";
// Properties a JavaScript module adds to a child it did not spawn: reads,
// accessor calls on the child, a write to a getter-only accessor, and the
// replaced kill.
const patched = require("./patcher.cjs");
const child = patched();
console.log(child.label);
child.label = "x";
console.log(child.stored, child.same);
try {
  child.same = 1;
} catch (e) {
  console.log(e instanceof TypeError, e.message);
}
child.on("close", (code) => {
  console.log("close", code, child.killedBy);
});
child.kill("SIGTERM");

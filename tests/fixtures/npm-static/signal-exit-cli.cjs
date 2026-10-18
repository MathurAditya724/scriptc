// signal-exit@3 forwards process.emit through a sloppy-mode wrapper that
// reads `arguments` with original.apply(this, arguments).
const onExit = require("signal-exit");
onExit(function (code) {
  console.log("exit", code);
});
console.log("registered");

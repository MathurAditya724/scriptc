// Sloppy-mode functions whose mapped `arguments` aliasing is observable,
// and `arguments` uses the native array cannot represent, keep a named
// runtime fence. The admitted forms compile statically.
function readsWritten(a) {
  a = 2;
  return arguments[0];
}
function writesArguments(a) {
  arguments[0] = 7;
  return a;
}
function escapes(a) {
  inspect(arguments);
  return a;
}
function inspect(args) {
  return args.length;
}
function callee(a) {
  return arguments.callee === callee;
}
function strictWrite(a) {
  "use strict";
  arguments[0] = 1;
  return a;
}
function admitted(a, b) {
  b = 1;
  return [arguments.length, arguments[0], a, b];
}
console.log(admitted(1, 2));
if (process.argv.length > 9) {
  readsWritten(1);
  writesArguments(1);
  escapes(1);
  callee(1);
  strictWrite(1);
}

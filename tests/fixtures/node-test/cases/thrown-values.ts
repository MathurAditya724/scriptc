// @exit: 1
// Failures from thrown non-Error values print as Node inspects them: a
// string quoted, a number and a boolean as written.
import { test } from "node:test";

test("throws a string", () => {
  throw "plain string";
});
test("throws a string with a quote", () => {
  throw "it's quoted";
});
test("throws a number", () => {
  throw 42;
});
test("throws a boolean", () => {
  throw false;
});

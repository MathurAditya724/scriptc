// Inspecting an Error-typed value whose runtime class declares fields
// prints the stackless error base, with Node's constructor-name header
// (`[Bailable [Error]: m]`), followed by the own properties — on one line
// or broken across lines by the same width rule as any object, and as
// `[Name]` beyond the depth budget. (The stack is cleared: compiled errors
// carry none.)
import * as util from "node:util";
class Bailable extends Error {
  bail = false;
}
class Detailed extends Bailable {
  attempts: number[] = [];
  label = "x";
}
function clean<E extends Error>(e: E): E {
  e.stack = "";
  return e;
}
function show(error: Error): void {
  console.log(util.format(error));
  console.log(util.format("%s", error));
  console.log(util.inspect({ wrapped: { deeper: { error } } }));
}
const b = clean(new Bailable("download failed"));
b.bail = true;
show(b);
show(clean(new Error("plain")));
const d = clean(new Detailed("y".repeat(70)));
d.attempts.push(1, 2);
show(d);
class FetchFailedError extends Error {
  status = 0;
}
const f = clean(new FetchFailedError("not found"));
f.status = 404;
show(f);
class Plain extends Error {}
show(clean(new Plain("field-less beside fielded subclasses")));

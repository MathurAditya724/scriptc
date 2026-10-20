// Inspecting an instance of a program-declared Error subclass names its
// constructor the way Node's improveStack does: `[Plain [Error]: m]`, or
// `[FetchFailedError: m]` when the constructor name already contains the
// error's name; runtime error classes keep their own header. (The stack is
// cleared: compiled errors carry none.)
import * as util from "node:util";

class Plain extends Error {}
class FetchFailedError extends Error {}
class Deeper extends Plain {}

function clean(error: Error): Error {
  error.stack = "";
  return error;
}

function show(error: Error): void {
  console.log(util.format(error), "|", util.format("%s", error));
  console.log(util.inspect({ nested: error }));
}

show(clean(new Plain("p")));
show(clean(new FetchFailedError("f")));
show(clean(new Deeper("d")));
show(clean(new Error("plain")));
show(clean(new TypeError("type")));
const typed: Plain = new Deeper("typed as the base");
typed.stack = "";
console.log(util.inspect(typed));
const listed = [new Plain("in an array")];
listed[0]!.stack = "";
console.log(util.inspect(listed));

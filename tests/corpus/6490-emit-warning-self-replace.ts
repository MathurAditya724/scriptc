// A process.emitWarning replacement that assigns a new replacement while it
// runs keeps running with its own captured variables: the call keeps the
// replaced function alive until it returns. Covers process.emitWarning
// calls and the warnings Node's own modules emit (a util.deprecate
// wrapper's first call).
import { deprecate } from "node:util";

function install(label: string): void {
  let calls = 0;
  const seen: string[] = [label];
  process.emitWarning = ((warning: unknown) => {
    process.emitWarning = ((next: unknown) => {
      console.log("replacement", String(next));
    }) as typeof process.emitWarning;
    calls++;
    seen.push(String(warning));
    console.log("first", label, calls, seen.join(","));
  }) as typeof process.emitWarning;
}

install("direct");
process.emitWarning("a");
process.emitWarning("b");

install("deprecate");
const old = deprecate(() => "result", "old() is deprecated", "DEP_SCRIPTC_2");
console.log("call", old());
process.emitWarning("c");

function throwing(label: string): void {
  let calls = 0;
  process.emitWarning = (() => {
    process.emitWarning = ((next: unknown) => {
      console.log("after throw", String(next));
    }) as typeof process.emitWarning;
    calls++;
    throw new Error(`${label} ${calls}`);
  }) as typeof process.emitWarning;
}

throwing("thrown");
try {
  process.emitWarning("d");
} catch (error) {
  console.log("caught", (error as Error).message);
}
process.emitWarning("e");

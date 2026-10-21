// Loading Node on first use (tests/harness/node-island.test.ts): the
// argument selects whether and how the program calls into Node.
import { readFileSync } from "node:fs";
import { callSync } from "@scriptc/node";

const mode = process.argv[2] ?? "call";
const mapped = (): boolean =>
  process.platform !== "linux" || readFileSync("/proc/self/maps", "utf8").includes("libnode");
console.log("mapped before", mapped());
if (mode !== "never") {
  console.log(callSync<number>("./helper.cjs", "answer"));
  console.log("mapped after", mapped());
}
if (mode === "exit") process.exit(5);
console.log("done");

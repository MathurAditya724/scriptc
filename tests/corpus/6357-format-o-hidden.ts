// util.format's %o over values reached through `unknown` renders with
// showHidden, as Node does: arrays show their hidden `[length]` (with
// Node's grouping), at every depth, inside Maps and records too.
import { format } from "node:util";
const cases: [string, unknown][] = [
  ["ten", Array.from({ length: 10 }, (_, i) => i)],
  ["wide", Array.from({ length: 120 }, (_, i) => i)],
  ["hundred", Array.from({ length: 100 }, (_, i) => i)],
  ["hundred-one", Array.from({ length: 101 }, (_, i) => i)],
  ["hundred-strs", Array.from({ length: 100 }, (_, i) => "s" + i)],
  ["seven", ["aaaaaaaaaaaaaaaaaaaa", "b", "c", "d", "e", "f", "g"]],
  ["strs", Array.from({ length: 30 }, (_, i) => "s" + i)],
  ["holes", [1, , 3]],
  ["empty", []],
  ["nested", { list: [[]], m: new Map([[1, [2]]]) }],
  ["deep", [[[[[[1]]]]]]],
  ["date", [new Date(0)]],
];
for (const [k, v] of cases) console.log(k, format("%o", v));

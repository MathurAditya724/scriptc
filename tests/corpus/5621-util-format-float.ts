// util.format and console.log %f: parseFloat(String(arg)) formatted, for
// numbers (-0 prints 0), strings, booleans, unit values and checked-dynamic values.
import { format } from "node:util";
const n: number = Number(process.argv.length > 99 ? "1" : "-0");
const s: string = process.argv[2] ?? "3.5kg";
const flag = process.argv.length > 99;
const u: unknown = JSON.parse('{"a":1}');
const v: unknown = JSON.parse('"2.5e1x"');
console.log(format("%f|%f|%f|%f|%f|%f", 1.5, n, -0, s, "abc", flag));
console.log(format("%f %f %f %f", Infinity, NaN, undefined, null));
console.log(format("%f %f", u, v));
console.log(format("%s:%d:%i:%f:%j:%O %%", "a", 1.5, 2.7, "3.5", { a: 1 }, [1]));
console.log(format("%f", 1, "extra"), format("%f"));
console.log("%f and %f", "1.25e2px", 0.1 + 0.2);

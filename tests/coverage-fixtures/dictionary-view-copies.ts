// A class instance or record held as `{}`, `object` or `unknown` keeps the
// original object, and converting it to a dictionary type copies it field
// by field. Each site below then writes through or compares the copy.
class Counter {
  label = "c";
  add(): number {
    return this.label.length;
  }
}
const key = process.argv.length > 5 ? "z" : "b";

const counter = new Counter();
const view: {} = counter;
const table: Record<string, string> = view;
table[key] = "y";

const point = { a: "x" };
const loose: object = point;
const dict = loose as Record<string, string>;
dict[key] = "y";

const held: unknown = { a: "x" };
const fromUnknown = held as Record<string, string>;
console.log(fromUnknown === held);

const empty: {} = {};
const filled: Record<string, string> = empty;
filled[key] = "y";
console.log(JSON.stringify(counter), JSON.stringify(point), JSON.stringify(empty));

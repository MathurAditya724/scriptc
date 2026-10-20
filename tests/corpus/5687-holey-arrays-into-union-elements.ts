// Holey string[] arrays converted into (string | number)[] storage: through
// a spread, a record field, a shorthand field, a call argument, a return
// value and an assignment. The holes read as undefined, iteration and the
// find family visit them, and forEach, map and `in` keep them as holes.

function holey(): string[] {
  const h = new Array<string>(2);
  h[2] = "c";
  return h;
}

function describe(label: string, xs: (string | number)[]): void {
  const types: string[] = [];
  for (const x of xs) types.push(typeof x);
  let visited = 0;
  xs.forEach(() => visited++);
  console.log(
    label,
    xs.length,
    types.join(","),
    visited,
    xs.findIndex((x) => x === undefined),
    1 in xs,
    xs.map((x) => `<${x}>`).length,
  );
}

const spread: (string | number)[] = [...holey()];
describe("spread", spread);

const lengthened: string[] = ["a"];
lengthened.length = 3;
interface Bag {
  items: (string | number)[];
}
const bag: Bag = { items: lengthened };
describe("field", bag.items);

const items = holey();
const shorthand: Bag = { items };
describe("shorthand", shorthand.items);

const sparse: string[] = [];
sparse[3] = "d";
describe("argument", sparse);

function widen(): (string | number)[] {
  const gappy: string[] = ["a"];
  gappy[2] = "c";
  return gappy;
}
describe("return", widen());

let assigned: (string | number)[] = [1];
assigned = holey();
describe("assignment", assigned);

const dense: string[] = ["x", "y"];
const denseBag: Bag = { items: dense };
describe("dense", denseBag.items);

// Member reads and writes through non-null asserted array element reads.
// `!` performs no runtime check: a missing element is undefined, so the
// member access throws Node's TypeError, which the program can catch.

class Cell {
  count = 0;
  label: string;
  constructor(label: string) {
    this.label = label;
  }
  bump(): number {
    return ++this.count;
  }
}

function cell(label: string): Cell {
  return new Cell(label);
}

const cells = [cell("a"), cell("b")];
const words = ["alpha", "beta"];
const grid = [
  [1, 2],
  [3, 4],
];
const maps = [new Map<string, number>([["x", 1]])];
const holey: Cell[] = [];
holey[2] = cell("z");
let reads = 0;
function at(n: number): number {
  reads++;
  return n;
}

function attempt(label: string, f: () => unknown): void {
  try {
    console.log(label.padEnd(12), "ok", f());
  } catch (e) {
    const error = e as Error;
    console.log(label.padEnd(12), error instanceof TypeError, error.message);
  }
}

for (const k of [0, 1, 2, -1]) {
  attempt(`label ${k}`, () => cells[k]!.label);
  attempt(`bump ${k}`, () => cells[k]!.bump());
  attempt(`set ${k}`, () => (cells[k]!.label = "set"));
  attempt(`count++ ${k}`, () => cells[k]!.count++);
  attempt(`length ${k}`, () => words[k]!.length);
  attempt(`upper ${k}`, () => words[k]!.toUpperCase());
  attempt(`grid ${k}`, () => grid[k]![0]);
  attempt(`row ${k}`, () => {
    const j = 1;
    return grid[k]![j];
  });
  attempt(`push ${k}`, () => grid[k]!.push(9));
  attempt(`map ${k}`, () => maps[k]!.get("x"));
}

attempt("hole", () => holey[0]!.label);
attempt("hole value", () => holey[2]!.label);
attempt("order", () => cells[at(7)]!.count + at(1));
console.log("reads", reads);

let total = 0;
try {
  for (let i = 0; i < 4; i++) total += grid[i]![0]!;
} catch (e) {
  console.log("loop", (e as Error).message, total);
}
console.log(cells.map((c) => `${c.label}:${c.count}`).join(" "));

// Functions returning unions of numbers, strings, class instances, records
// and arrays: fields, parameters, fresh values and conditionals as returns,
// results read in place, bound, rebound, stored, passed on and discarded.
class Point {
  x: number;
  y: number;
  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
  }
}
class Label {
  text: string;
  constructor(text: string) {
    this.text = text;
  }
}
type Shape = { kind: string; size: number };

function pick(i: number): number | string {
  return i % 2 === 0 ? i * 1.5 : "s" + String(i);
}

function choose(i: number, p: Point, l: Label): Point | Label | undefined {
  if (i % 3 === 0) return p;
  if (i % 3 === 1) return new Label(l.text + String(i));
  return undefined;
}

function shapeOrList(i: number): Shape | number[] | null {
  if (i < 0) return null;
  return i % 2 === 0 ? { kind: "sq", size: i } : [i, i + 1, i + 2];
}

function passThrough(v: number | string): number | string {
  return v;
}

function nested(i: number): string | Point | boolean {
  return i > 4 ? (i > 8 ? "big" : new Point(i, -i)) : i === 0;
}

function describe(v: Point | Label | undefined): string {
  if (v === undefined) return "none";
  return v instanceof Point ? `P(${v.x},${v.y})` : `L(${v.text})`;
}

// Read in place.
let total = 0;
for (let i = 0; i < 10; i++) {
  const v = pick(i);
  total += typeof v === "number" ? v : v.length;
}
console.log(total, typeof pick(3), pick(4) === 6, pick(5) === "s5");

// Bound, rebound and kept past the loop.
const p = new Point(1, 2);
const l = new Label("lab");
let last: Point | Label | undefined = undefined;
const kept: (Point | Label | undefined)[] = [];
for (let i = 0; i < 7; i++) {
  last = choose(i, p, l);
  kept.push(choose(i, p, l));
  console.log(i, describe(last), describe(choose(i + 1, p, l)), choose(i, p, l) === p);
}
console.log(kept.map(describe).join(" "), describe(last));

// Records, arrays and null.
for (const i of [-1, 0, 1, 2, 3]) {
  const s = shapeOrList(i);
  if (s === null) console.log("null");
  else if (Array.isArray(s)) console.log("list", s.join("+"), s.length);
  else console.log("shape", s.kind, s.size);
}
console.log(JSON.stringify([shapeOrList(4), shapeOrList(5), shapeOrList(-2)]));

// Parameters and nested conditionals as returns; discarded results.
console.log(passThrough(pick(6)), passThrough("x"), passThrough(passThrough(7)));
for (const i of [0, 3, 6, 9]) {
  const n = nested(i);
  console.log(typeof n, n instanceof Point ? n.x + n.y : n);
}
pick(1);
choose(1, p, l);
shapeOrList(3);

// Results passed straight to other functions and compared.
function len(v: number | string): number {
  return typeof v === "string" ? v.length : v;
}
let sum = 0;
for (let i = 0; i < 100; i++) sum += len(pick(i)) + (pick(i) === pick(i) ? 1 : 0);
console.log(sum);

// Through a function value: the boxed calling convention.
const fns: ((i: number) => number | string)[] = [pick, (i) => i];
console.log(fns.map((f) => f(3)).join(","), fns.map((f) => typeof f(2)).join(","));

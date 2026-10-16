// Union results that hold the only reference to their value, results whose
// source changes after the call, recursion, exceptions and cycles.
class Node {
  name: string;
  next: Node | undefined;
  constructor(name: string) {
    this.name = name;
    this.next = undefined;
  }
}
class Leaf {
  value: number;
  constructor(value: number) {
    this.value = value;
  }
}

// A fresh value whose only reference is the result.
function make(i: number): Node | Leaf | string {
  if (i % 3 === 0) return new Node("n" + String(i));
  if (i % 3 === 1) return new Leaf(i);
  return "str" + String(i);
}
let names = "";
for (let i = 0; i < 9; i++) {
  const v = make(i);
  names += v instanceof Node ? v.name : v instanceof Leaf ? String(v.value) : v;
  names += make(i + 1) instanceof Leaf ? "!" : ".";
}
console.log(names);

// The holder releases the value after the call returns it.
class Holder {
  slot: Node | Leaf;
  constructor() {
    this.slot = new Leaf(1);
  }
  swap(next: Node | Leaf): Node | Leaf {
    const old = this.slot;
    this.slot = next;
    return old;
  }
}
const h = new Holder();
function take(holder: Holder, i: number): Node | Leaf {
  return holder.swap(i % 2 === 0 ? new Node("h" + String(i)) : new Leaf(i * 10));
}
for (let i = 0; i < 5; i++) {
  const got = take(h, i);
  console.log(got instanceof Node ? got.name : got.value, h.slot instanceof Node);
}

// Recursion returning unions.
function walk(n: Node | undefined, depth: number): Node | Leaf | number {
  if (n === undefined) return depth;
  if (depth > 2) return new Leaf(depth);
  const inner = walk(n.next, depth + 1);
  return typeof inner === "number" ? n : inner;
}
const a = new Node("a");
a.next = new Node("b");
a.next.next = new Node("c");
a.next.next.next = new Node("d");
for (const start of [a, a.next, a.next.next, undefined]) {
  const r = walk(start, 0);
  console.log(typeof r === "number" ? r : r instanceof Node ? r.name : r.value);
}

// Cycles held only by a union result.
function cycle(i: number): Node | number {
  if (i < 0) return i;
  const x = new Node("x" + String(i));
  const y = new Node("y" + String(i));
  x.next = y;
  y.next = x;
  return x;
}
let hops = 0;
for (let i = -2; i < 50; i++) {
  const c = cycle(i);
  if (typeof c !== "number") hops += c.next!.next === c ? 1 : 0;
}
console.log(hops);

// Exceptions before and after the result is built.
function risky(i: number): Leaf | string {
  if (i === 3) throw new RangeError("bad " + String(i));
  const s = "v" + String(i);
  if (i === 5) throw new TypeError(s);
  return i % 2 === 0 ? new Leaf(i) : s;
}
function use(i: number): string {
  try {
    const r = risky(i);
    return r instanceof Leaf ? "leaf" + String(r.value) : r;
  } catch (error) {
    return (error as Error).name + ":" + (error as Error).message;
  } finally {
    names = names.slice(1);
  }
}
console.log([0, 1, 2, 3, 4, 5, 6].map(use).join(" "), names.length);

// A result used after the callee's own data changed.
const table: (Leaf | string)[] = [new Leaf(1), "two", new Leaf(3)];
function at(i: number): Leaf | string {
  return table[i]!;
}
const before = at(0);
table[0] = "replaced";
table.length = 0;
console.log(before instanceof Leaf ? before.value : before, table.length);

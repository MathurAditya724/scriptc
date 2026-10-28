// `.length` of computed tuple expressions: call results, ternaries, `as`
// assertions, `as const` literals, member reads (fields and accessors) and
// element reads. The receiver is evaluated once, in order, for its side
// effects and exceptions, and the length is the tuple's arity.

const log: string[] = [];

function pair(tag: string): [number, string] {
  log.push(`pair ${tag}`);
  return [1, tag];
}

function triple(): [number, string, boolean] {
  log.push("triple");
  return [1, "x", true];
}

function failing(): [number, number] {
  log.push("failing");
  throw new Error("no tuple");
}

class Holder {
  plain: [string, string] = ["a", "b"];
  reads = 0;
  get viaAccessor(): [number, number, number] {
    this.reads++;
    log.push("accessor");
    return [this.reads, 2, 3];
  }
  ownLength(): number {
    return this.plain.length + this.viaAccessor.length;
  }
}

const nested: [[number, number], [string, string, string]] = [
  [1, 2],
  ["a", "b", "c"],
];

let flip = 0;
function pick(): boolean {
  flip++;
  return flip % 2 === 1;
}

console.log(pair("call").length);
console.log((pick() ? triple() : ([0, "", false] as [number, string, boolean])).length);
console.log((pick() ? triple() : ([0, "", false] as [number, string, boolean])).length);
console.log(([1, 2, 3] as const).length);
console.log(([flip, "y"] as [number, string]).length);

const h = new Holder();
console.log(h.plain.length, h.viaAccessor.length, h.viaAccessor.length, h.reads);
console.log(h.ownLength(), h.reads);
console.log(nested[0].length, nested[1].length, nested.length);

// Evaluation order inside one expression, and in a loop condition.
const sum = pair("left").length + triple().length * 10 + pair("right").length * 100;
console.log(sum);
let rounds = 0;
for (let i = 0; i < pair(`loop ${i}`).length; i++) rounds++;
console.log(rounds);
console.log(`${pair("template").length}:${typeof triple().length}`);

// An exception in the receiver propagates; no length is produced.
try {
  console.log(failing().length);
} catch (e) {
  console.log("caught", (e as Error).message);
}

console.log(log.join(" | "));

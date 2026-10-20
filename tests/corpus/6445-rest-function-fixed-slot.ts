// A rest-parameter function in a slot with fixed parameters: the slot's
// arguments arrive in the rest array, as in a JavaScript call.
function log(...messages: string[]): void {
  console.log(`log(${messages.length}):`, messages.join(" | "));
}
function tagged(tag: string, ...values: number[]): number {
  console.log(tag, values.join(","));
  return values.length;
}

class Line {
  private readonly sink: (m: string) => void;
  constructor(sink: (m: string) => void) {
    this.sink = sink;
  }
  emit(m: string): void {
    this.sink(m);
  }
}

new Line(log).emit("one");
const pair: (a: string, b: string) => void = log;
pair("x", "y");
const none: () => void = log;
none();
const count: (tag: string, a: number, b: number) => number = tagged;
console.log("count", count("t", 1, 2));
["a", "b"].forEach((m) => new Line(log).emit(m));

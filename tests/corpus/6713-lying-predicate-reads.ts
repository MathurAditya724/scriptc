// Hand-written type predicates and assertion functions are claims TypeScript
// does not check. When one lies, reads through the claimed reference behave as
// in Node: members the value lacks read undefined, members it has read their
// own values, and calling a method it lacks throws the catchable TypeError.
// This covers predicates and assertions on bindings, member chains, `this`
// predicates, `asserts condition`, class claims and catch bindings.
function show(label: string, run: () => unknown): void {
  try {
    console.log(label, run());
  } catch (error) {
    const e = error as Error;
    console.log(label, "throws", e.name, e.message);
  }
}
function isText(x: string | number): x is string {
  return true;
}
function isList(x: string | number[]): x is number[] {
  return true;
}
function check(condition: unknown): asserts condition {}
class Box {
  v: string | number;
  constructor(v: string | number) {
    this.v = v;
  }
  holdsText(): this is { v: string } {
    return true;
  }
}
const values: (string | number)[] = ["hi", 5];
for (const v of values) {
  show("length", () => (isText(v) ? v.length : -1));
  show("plus", () => (isText(v) ? v.length + 1 : -1));
  show("call", () => (isText(v) ? v.trim() : "-"));
  const o = { v };
  show("member chain", () => (isText(o.v) ? o.v.length : -1));
  show("asserts cond", () => {
    check(typeof v === "string");
    return v.length;
  });
  const b = new Box(v);
  show("this predicate", () => (b.holdsText() ? b.v.length : -1));
}
const lists: (string | number[])[] = [[1, 2], "abc"];
for (const l of lists) show("other arm has it", () => (isList(l) ? l.length : -1));
function truthful(x: string | number): x is string {
  return typeof x === "string";
}
for (const v of values) show("truthful", () => (truthful(v) ? v.length : -1));

class Base {
  name = "base";
}
class Sub extends Base {
  extra = "sub";
  hello(): string {
    return "hello";
  }
}
function isSub(x: Base): x is Sub {
  return true;
}
for (const b of [new Sub(), new Base()]) {
  show("extra", () => (isSub(b) ? b.extra : "-"));
  show("hello", () => (isSub(b) ? b.hello() : "-"));
  show("name", () => (isSub(b) ? b.name : "-"));
}
function isRange(e: unknown): e is RangeError {
  return true;
}
try {
  throw new TypeError("boom");
} catch (e) {
  if (isRange(e)) console.log("caught", e.message, e.name);
}

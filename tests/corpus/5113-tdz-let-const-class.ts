// let, const and class bindings read through functions before their
// declarations run throw Node's ReferenceError.
function readLet(): number {
  return counter;
}
function readConst(): string {
  return greeting;
}
function makeWidget(): object {
  return new Widget();
}
function widgetTag(): string {
  return Widget.tag;
}
function widgetCount(): number {
  return Widget.count();
}
function isWidget(x: unknown): boolean {
  return x instanceof Widget;
}
function setTag(): void {
  Widget.tag = "changed";
}
const attempts: [string, () => unknown][] = [
  ["let", readLet],
  ["const", readConst],
  ["new", makeWidget],
  ["static field", widgetTag],
  ["static method", widgetCount],
  ["instanceof", () => isWidget({})],
  ["static write", setTag],
];
for (const [label, run] of attempts) {
  try {
    console.log(label, "ok", String(run()));
  } catch (e) {
    console.log(label, (e as Error).name, (e as Error).message, e instanceof ReferenceError);
  }
}
let counter = 1;
const greeting = "hi";
class Widget {
  static tag = "w";
  static made = Widget.tag + "!";
  static count(): number {
    return 7;
  }
}
console.log(readLet(), readConst(), typeof makeWidget(), widgetTag(), widgetCount());
console.log(isWidget(makeWidget()), Widget.made);
setTag();
console.log(widgetTag());

// A static initializer that calls out to code naming the class.
function early(): string {
  return Later.label;
}
class Later {
  static label = "later";
  static probe = (() => {
    try {
      return early();
    } catch (e) {
      return (e as Error).message;
    }
  })();
}
console.log(Later.probe, early());

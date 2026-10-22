function make(name, params) {
  const Parent = (params && params.Parent) || Object;
  class Definition extends Parent {
    describe() {
      return `${name}:${this.kind}`;
    }
  }
  return Definition;
}
const A = make("A");
const a = new A();
a.kind = "plain";
console.log(typeof a, a instanceof A, a.describe(), JSON.stringify(a), Object.keys(a));
const E = make("E", { Parent: Error });
const e = new E("boom");
e.kind = "error";
console.log(e instanceof E, e.message, typeof e.stack, e.describe(), Object.keys(e), String(e));
const Parent = E;
console.log(e instanceof Parent, new E() .message === "", Object.prototype.hasOwnProperty.call(new E(), "message"));
try {
  throw new E("thrown");
} catch (err) {
  console.log(err instanceof E, err.message);
}

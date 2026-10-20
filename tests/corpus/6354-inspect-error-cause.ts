// Errors print a non-enumerable `cause` and an AggregateError's `errors`
// after their own keys, as `[cause]` and `[errors]`, like Node's formatError.
Error.stackTraceLimit = 0;
const undef = new Error("u", { cause: undefined });
console.log(undef);
const assigned = new Error("a");
assigned.cause = "later";
console.log(assigned);
const self = new Error("self");
self.cause = self;
const loop = new Error("loop", { cause: self });
console.log(loop);
let deep = new Error("e0");
for (let i = 1; i < 5; i++) deep = new Error(`e${i}`, { cause: deep });
console.log(deep);
console.log({ wrap: { inner: new Error("w", { cause: new Error("c") }) } });
console.log(new Error("obj", { cause: { code: 1, list: [1, 2] } }));
const agg = new AggregateError([new Error("x", { cause: 1 })], "agg", { cause: "why" });
console.log(agg);
console.log(new AggregateError([], "empty"));
const outer = new Error("outer", { cause: new TypeError("inner") });
console.log(outer);
const text = new Error("c", { cause: "text" });
console.log(text, [text]);
const viaUnknown: unknown = new Error("u", { cause: new RangeError("r") });
console.log(viaUnknown);

// Object literals with get/set accessors keep their closures in reserved
// slots, so their typed values have no JSON or checked-dynamic form: Node's
// JSON.stringify and dynamic reads invoke the getter, which neither a typed
// serializer nor a converted copy could do.

function hold(value: unknown): unknown {
  return value;
}

const counter = {
  count: 1,
  get doubled(): number {
    return 2;
  },
};

// JSON.stringify of the typed value would omit the getter's property.
console.log(JSON.stringify(counter));

// Converting the typed value to `unknown` or `any` would lose the getter.
hold(counter);
const viaAny: any = counter;
console.log(viaAny);

// A literal written into an `any` slot directly keeps its accessor.
const direct: any = {
  get value(): number {
    return 3;
  },
};
console.log(direct.value);

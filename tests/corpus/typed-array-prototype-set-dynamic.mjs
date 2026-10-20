// wasm-bindgen's cached view is a checked-dynamic value in JavaScript.
let cached = null;
function memory() {
  if (cached === null) cached = new Uint8Array(4);
  return cached;
}
function copy(value, source, offset) {
  return Uint8Array.prototype.set.call(value, source, offset);
}
console.log(copy(memory(), new Uint8Array([3, 4]), 1));
console.log(String(memory()));
console.log(copy(new Int16Array([1, 2, 3]), [300], 1));
for (const value of [null, undefined, {}, [], new DataView(new ArrayBuffer(4))]) {
  try { copy(value, [1], 0); } catch (error) { console.log(error.name, error.message); }
}

for (const [source, offset] of [[[1n], 0], [[1], 1n], [[1], -1], [[1], 4]]) {
  try { copy(memory(), source, offset); } catch (error) { console.log(error.name, error.message); }
}
const order = [];
try {
  copy({}, [1], { valueOf() { order.push("wrong-offset"); return 0; } });
} catch (error) { console.log(error.name, error.message); }
copy(memory(), {
  get length() { order.push("length"); return 1; },
  get 0() { order.push("element"); return 9; }
}, { valueOf() { order.push("offset"); return 0; } });
console.log(order.join(","), String(memory()));

const dataViewSource = new DataView(new ArrayBuffer(2));
dataViewSource.setUint8(0, 99);
Uint8Array.prototype.set.call(memory(), dataViewSource);
console.log(String(memory()));
try { copy(memory(), dataViewSource, 5); } catch (error) { console.log(error.name, error.message); }

// ToObject boxes non-string primitives; their missing length makes the copy empty.
for (const source of [1n, Symbol("source"), false, 42]) {
  console.log(copy(memory(), source, 1), String(memory()));
  const direct = memory();
  console.log(direct.set(source, 1), String(direct));
  try { copy(memory(), source, 5); } catch (error) { console.log(error.name, error.message); }
}

// Constructors use ToIndex instead of set/from's ToObject array-like source.
function construct(value) { return new Uint8Array(value); }
for (const source of [1n, Symbol("length")]) {
  console.log(String(Uint8Array.from(source)));
  try { construct(source); } catch (error) { console.log(error.name, error.message); }
}

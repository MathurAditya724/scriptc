// wasm-bindgen copies host bytes into linear memory through the borrowed builtin.
const target = new Uint8Array([0, 0, 0, 0]);
Uint8Array.prototype.set.call(target, new Uint8Array([5, 6]), 1);
console.log(Array.from(target).join(","));
Uint8Array.prototype.set.call(target, [7, 8], undefined);
console.log(Array.from(target).join(","));
Uint8Array.prototype.set.call(target, target.subarray(0, 3), 1);
console.log(Array.from(target).join(","));

const order: string[] = [];
function receiver(): Uint8Array {
  order.push("receiver");
  return target;
}
function source(): Uint8Array {
  order.push("source");
  return new Uint8Array([9]);
}
function offset(): number {
  order.push("offset");
  return 2;
}
Uint8Array.prototype.set.call(receiver(), source(), offset());
console.log(order.join(","), Array.from(target).join(","));

for (const offset of [-1, 4]) {
  try {
    Uint8Array.prototype.set.call(target, [1], offset);
  } catch (error) {
    if (error instanceof Error) console.log(error.name, error.message);
  }
}

const wide = new Int16Array([0, 0, 0]);
Uint8Array.prototype.set.call(wide, new Int16Array([300, -2]), 1);
console.log(Array.from(wide).join(","));

try {
  Uint8Array.prototype.set.call(new DataView(new ArrayBuffer(4)), new Uint8Array([1]));
} catch (error) {
  if (error instanceof Error) console.log(error.name, error.message);
}

// Overlapping views of different element kinds must snapshot before conversion.
const backing = new ArrayBuffer(16);
const floatSource = new Float32Array(backing);
floatSource.set([1.5, -2.25, Infinity, NaN]);
const overlapping = new Int16Array(backing, 2, 4);
Uint8Array.prototype.set.call(overlapping, floatSource);
console.log(Array.from(overlapping).join(","));
const clamped = new Uint8ClampedArray(6);
Uint8Array.prototype.set.call(clamped, [-1, 1.5, 2.5, 300, NaN, Infinity]);
console.log(String(clamped));
const bufferTarget = Buffer.from([0, 0]);
Uint8Array.prototype.set.call(bufferTarget, new Uint16Array([300, 511]));
console.log(bufferTarget[0], bufferTarget[1]);

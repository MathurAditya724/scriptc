// Resizable ArrayBuffers: maxByteLength and resizable, resize, length-tracking
// and fixed-length views going out of bounds and back, zeroed growth,
// subarray, DataView, and typed-array methods on out-of-bounds views.
const report = (label: string, f: () => unknown): void => {
  try {
    console.log(label, f());
  } catch (e) {
    console.log(label, (e as Error).name, (e as Error).message);
  }
};
const buf = new ArrayBuffer(8, { maxByteLength: 16 });
console.log(buf.byteLength, buf.maxByteLength, buf.resizable);
const track = new Uint8Array(buf);
const fixed = new Uint8Array(buf, 0, 4);
const tail = new Uint16Array(buf, 4);
track[0] = 1;
track[7] = 7;
console.log(track.length, fixed.length, tail.length, track.byteLength, tail.byteOffset);
buf.resize(12);
console.log(buf.byteLength, track.length, fixed.length, tail.length, track[7], track[11]);
buf.resize(2);
console.log(buf.byteLength, track.length, fixed.length, tail.length, fixed[0], fixed[3]);
fixed[1] = 9;
console.log(fixed[1], track[1], fixed.byteOffset, tail.byteOffset, tail.byteLength);
buf.resize(16);
console.log(track.length, fixed.length, tail.length, track[1], track[7], track.join(""));
report("too large", () => buf.resize(17));
report("negative", () => buf.resize(-1));
buf.resize(3.7);
console.log(buf.byteLength, track.length);
const fixedBuf = new ArrayBuffer(4);
console.log(fixedBuf.resizable, fixedBuf.maxByteLength);
console.log(new ArrayBuffer(4, {}).resizable, new ArrayBuffer(4, { maxByteLength: undefined }).resizable);
report("max", () => new ArrayBuffer(8, { maxByteLength: 4 }));

const b = new ArrayBuffer(8, { maxByteLength: 16 });
const view = new Uint8Array(b, 4, 4);
const tracking = new Uint16Array(b, 4);
const doubles = new Float64Array(b, 0, 1);
const dv = new DataView(b, 4, 4);
const sub = new Uint8Array(b).subarray(2);
const sub2 = new Uint8Array(b).subarray(2, 4);
b.resize(2);
report("sizes", () => [view.length, view.byteLength, view.byteOffset, tracking.length, sub.length, sub2.length]);
report("join", () => view.join());
report("slice", () => view.slice(0).length);
report("fill", () => view.fill(1).length);
report("fill f64", () => doubles.fill(1).length);
report("set", () => view.set([1]));
report("copyWithin", () => view.copyWithin(0, 1).length);
report("sort", () => view.sort().length);
report("toSorted", () => view.toSorted().length);
report("toReversed", () => view.toReversed().length);
report("with", () => view.with(0, 1).length);
report("spread", () => [...view].length);
report("Array.from", () => Array.from(view).length);
report("for-of", () => {
  let n = 0;
  for (const x of view) n += x;
  return n;
});
report("entries", () => {
  let n = 0;
  for (const [i] of view.entries()) n += i;
  return n;
});
report("copy", () => new Uint8Array(view).length);
report("subarray", () => view.subarray(0).length);
report("tracking subarray", () => tracking.subarray(0).length);
report("getUint8", () => dv.getUint8(0));
report("setUint8", () => dv.setUint8(0, 1));
report("DataView byteLength", () => dv.byteLength);
report("DataView byteOffset", () => dv.byteOffset);
b.resize(16);
report("back", () => [view.length, tracking.length, sub.length, dv.byteLength, dv.getUint8(0), view.join()]);
const grow = new ArrayBuffer(4, { maxByteLength: 8 });
const growing = new Uint8Array(grow);
let steps = 0;
for (const _ of growing) {
  steps++;
  if (steps === 1) grow.resize(8);
}
console.log(steps, grow.slice(1).byteLength, grow.slice(1).resizable);
const many = new ArrayBuffer(64, { maxByteLength: 256 });
const kept: Uint8Array[] = [];
for (let i = 0; i < 300; i++) {
  const view = new Uint8Array(many, i % 64, i % 2 === 0 ? undefined : 1);
  if (i % 3 === 0) kept.push(view);
}
many.resize(32);
let inBounds = 0;
for (const view of kept) if (view.length > 0) inBounds++;
many.resize(256);
console.log(kept.length, inBounds, kept.reduce((n, view) => n + view.length, 0));
// An iteration step throws once a fixed-length view goes out of bounds; a
// length-tracking view that shrinks ends the iteration.
const step = new ArrayBuffer(4, { maxByteLength: 8 });
const stepView = new Uint8Array(step, 0, 4);
report("step for-of", () => {
  for (const x of stepView) {
    console.log("step", x);
    step.resize(2);
  }
});
step.resize(4);
report("step entries", () => {
  for (const [i] of stepView.entries()) {
    console.log("step", i);
    step.resize(2);
  }
});
step.resize(4);
report("step stored", () => {
  const it = stepView.values();
  for (const x of it) {
    console.log("step", x);
    step.resize(2);
  }
});
report("stored out of bounds", () => {
  const it = stepView.values();
  for (const x of it) console.log("step", x);
});
step.resize(4);
report("step helper", () => {
  for (const x of stepView.values().map((v) => v + 1)) {
    console.log("step", x);
    step.resize(2);
  }
});
step.resize(4);
let shrinkSteps = 0;
for (const _ of new Uint8Array(step)) {
  shrinkSteps++;
  if (shrinkSteps === 2) step.resize(3);
}
console.log("shrink", shrinkSteps);

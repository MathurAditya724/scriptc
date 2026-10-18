// Buffer.concat over an untyped list (JavaScript's `const chunks = []`):
// Uint8Array elements concatenate, the length form pads or truncates, and
// a non-array list or a non-Uint8Array element throws Node's TypeError.
const chunks = [];
chunks.push(Buffer.from("ab"));
chunks.push(new Uint8Array([99, 100]));
console.log(Buffer.concat(chunks).toString());
console.log(Buffer.concat(chunks, 6));
console.log(Buffer.concat(chunks, 3).toString());
console.log(Buffer.concat([]).length);

const lists = [[1], ["a"], [Buffer.from("x"), null], "x", 5, [new Uint16Array(1)]];
for (const list of lists) {
  try {
    Buffer.concat(list);
    console.log("no error");
  } catch (e) {
    console.log(e.name, e.code, e.message);
  }
}

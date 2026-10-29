// A destructuring declaration whose source is one object or array type or
// null/undefined (`s.match(re)`, `items.find(...)`) throws Node's TypeError
// when the source is null or undefined, with V8's message for the source
// spelling, and binds normally otherwise.

function show(label, fn) {
  try {
    fn();
  } catch (error) {
    console.log(label, error instanceof TypeError, error.message);
  }
}

const text = "abc";
show("object-call", () => {
  const { index } = text.match(/z/);
  console.log("never", index);
});
show("object-empty", () => {
  const {} = text.match(/z/);
  console.log("never");
});
show("object-identifier", () => {
  const found = "abc".match(/z/);
  const { index, input } = found;
  console.log("never", index, input);
});
show("object-string-key", () => {
  const found = "abc".match(/z/);
  const { "index": at } = found;
  console.log("never", at);
});
show("array-method-call", () => {
  const [whole] = "abc".match(/z/);
  console.log("never", whole);
});
show("array-identifier", () => {
  const found = "abc".match(/z/);
  const [whole, group] = found;
  console.log("never", whole, group);
});

const items = [
  { name: "a", size: 1 },
  { name: "b", size: 2 },
];
show("object-undefined", () => {
  const { name } = items.find((item) => item.size > 5);
  console.log("never", name);
});
function firstMatch(text) {
  return text.match(/q/);
}
show("array-function-call", () => {
  const [first] = firstMatch("abc");
  console.log("never", first);
});

// Sources that hold a value bind as before.
const { index } = "abc".match(/b/);
const [whole] = "abc".match(/c/);
const { name, size } = items.find((item) => item.size > 1);
console.log("bound", index, whole, name, size);

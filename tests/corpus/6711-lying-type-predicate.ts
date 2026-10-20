// A hand-written type predicate is a claim TypeScript does not check. When
// it lies, the narrowed reads behave as in Node: a method the value lacks
// throws the catchable TypeError, and members the value has still answer.
function isText(x: string | number): x is string {
  return x !== "";
}
function shout(v: string | number): string {
  if (isText(v)) return v.toUpperCase();
  return "other";
}
const inputs: (string | number)[] = ["a", 42];
for (const v of inputs) {
  try {
    console.log(shout(v));
  } catch (error) {
    const e = error as Error;
    console.log("caught", e.name, e.message);
  }
}

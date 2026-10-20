// An assertion function is a claim TypeScript does not check. When it lies,
// the value keeps its own type, as in Node: reading a member it lacks gives
// undefined.
function assertText(x: string | number): asserts x is string {}
function width(v: string | number): number {
  assertText(v);
  return v.length;
}
const inputs: (string | number)[] = ["abc", 7];
for (const v of inputs) console.log(width(v));

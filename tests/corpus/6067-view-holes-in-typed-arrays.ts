// Holes written through an `unknown[]` or `any` view of a typed array are
// holes of the typed array: for...of visits them as undefined and the find
// family passes them to its callback, as in Node. The views reach the array
// through a binding, an `any` parameter, a generic instantiated with
// `unknown`, a record field, a class field and a nested array.

const numbers: number[] = [1, 2];
const numbersView: unknown[] = numbers;
numbersView[3] = 5;
for (const value of numbers) console.log("numbers", value, typeof value);
console.log(numbers.findIndex((value) => value === undefined));
console.log(numbers.findLastIndex((value) => value === undefined));
console.log(numbers.find((value) => value !== undefined && value > 1));

const grown: string[] = ["a"];
const grownView: unknown[] = grown;
grownView.length = 3;
for (const value of grown) console.log("grown", value);

function growAny(values: any): void {
  values[2] = 9;
}
const passed: number[] = [7];
growAny(passed);
for (const value of passed) console.log("passed", value);

function keep<T>(value: T): T {
  return value;
}
const kept: number[] = [3];
(keep<unknown>(kept) as unknown[])[2] = 4;
for (const value of kept) console.log("kept", value);

const boxed: number[] = [1];
const box: unknown = { values: boxed };
(box as { values: unknown[] }).values[2] = 3;
for (const value of boxed) console.log("boxed", value);

class Holder {
  values: number[] = [1, 2];
}
const holder = new Holder();
const holderView: unknown = holder;
(holderView as { values: unknown[] }).values[3] = 4;
for (const value of holder.values) console.log("holder", value);

const nested: number[][] = [[1]];
const nestedView: unknown[][] = nested;
nestedView[0]![2] = 3;
for (const value of nested[0]!) console.log("nested", value);

// A named property written through a view is not an element.
const named: number[] = [1, 2];
const bag = named as unknown as Record<string, unknown>;
bag["label"] = "x";
for (const value of named) console.log("named", value);
console.log(named.length, bag["label"]);

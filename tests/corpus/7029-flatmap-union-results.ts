// flatMap callbacks that return a value or an array: an array result
// appends its elements (holes skipped), any other result appends itself,
// and an empty `[]` arm appends nothing.
const words = ["a", "", "c", "", "e"];
console.log(words.flatMap((s) => (s ? s : [])));
console.log(words.flatMap((s, i) => (s ? [s, String(i)] : [])));

function expand(line: string): string | string[] {
  return line.includes(",") ? line.split(",") : line;
}
console.log(["x", "y,z", "w"].flatMap(expand), ["x", "y,z"].flatMap((l) => expand(l)).length);

const numbers = [1, 2, 3, 4];
console.log(numbers.flatMap((n) => (n % 2 ? n : [n, n * 10])));
const sparse: number[] = [];
sparse[0] = 1;
sparse[2] = 3;
console.log(numbers.flatMap((n) => (n === 2 ? sparse : n)));

interface Entry {
  name: string;
  tags?: string[];
}
const entries: Entry[] = [{ name: "a", tags: ["t1", "t2"] }, { name: "b" }];
console.log(entries.flatMap((e) => e.tags ?? []), entries.flatMap((e) => e.tags ?? e.name));
let calls = 0;
const out = words.flatMap((s) => {
  calls++;
  return s.length > 0 ? s.toUpperCase() : [];
});
console.log(out, calls);

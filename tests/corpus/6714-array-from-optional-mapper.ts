// Array.from(array, mapper) with a mapper whose result can be undefined
// although its type says it cannot: an element read past the end, or a
// member read through a type predicate that lies. The undefined lands in the
// result as Node stores it.
const rows: number[][] = [[1], [], [3, 4]];
console.log(Array.from(rows, (row) => row[0]).join(","));
console.log(Array.from(rows, (row, index) => row[index]));

function isText(x: string | number): x is string {
  return true;
}
const values: (string | number)[] = ["ab", 5, "xyz"];
console.log(Array.from(values, (v) => (isText(v) ? v.length : -1)));
console.log(values.map((v) => (isText(v) ? v.length : -1)));

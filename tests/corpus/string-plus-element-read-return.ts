// A function declared to return a string concatenates a string with an
// element of a readonly string array. A missing element reads as undefined,
// which `+` turns into "undefined" next to a string, so the result is always
// a string and its call can be used inline.

const PAD: readonly string[] = ["00", "01", "02"];

function label(i: number): string {
  return "x-" + PAD[i];
}
function date(y: number, m: number, d: number): string {
  return y + "-" + PAD[m] + "-" + PAD[d];
}
function suffix(i: number): string {
  return PAD[i] + "!";
}

console.log(label(1).length, label(1), label(7));
console.log(date(2026, 1, 2).length, date(2026, 2, 9));
console.log(suffix(0).toUpperCase(), suffix(5));

// Two possibly missing reads add to NaN when both are missing.
function pair(i: number, j: number): string {
  return PAD[i] + PAD[j];
}
const both = pair(8, 9);
console.log(pair(0, 1), typeof both, String(both));

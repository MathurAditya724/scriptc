// Nullable record receivers skip null/undefined and retain the typed walk's
// evaluation, binding, deletion and control-flow behavior.
type Row = { a: number; b: number; c: number };

function names(value: Row | null | undefined): string {
  let result = "";
  for (const key in value) result += key;
  return result;
}
console.log("names", names(null), names(undefined), names({ a: 1, b: 2, c: 3 }));

let evaluations = 0;
function receive(value: Row | null | undefined): Row | null | undefined {
  evaluations++;
  return value;
}
function once(value: Row | null | undefined): string {
  let result = "";
  for (const key in receive(value)) result += key;
  return result;
}
console.log("once", once(null), once(undefined), once({ a: 1, b: 2, c: 3 }), evaluations);

function captures(value: Row | null): string {
  const readers: (() => string)[] = [];
  for (const key in value) readers.push(() => key);
  return readers.map((read) => read()).join(",");
}
console.log("captures", captures(null), captures({ a: 1, b: 2, c: 3 }));

function cursor(value: Row | undefined): string {
  let key = "before";
  for (key in value) {
    if (key === "b") break;
  }
  return key;
}
console.log("cursor", cursor(undefined), cursor({ a: 1, b: 2, c: 3 }));

function labels(value: Row | null): string {
  let result = "";
  outer: for (const key in value) {
    for (let i = 0; i < 2; i++) {
      if (key === "b") continue outer;
      if (key === "c") break outer;
      result += key + i;
    }
  }
  return result;
}
console.log("labels", labels(null), labels({ a: 1, b: 2, c: 3 }));

function mutations(value: Record<string, number> | null): string {
  let result = "";
  for (const key in value) {
    result += key;
    if (key === "a") {
      delete value.b;
      value.d = 4;
    }
  }
  return result;
}
console.log("mutations", mutations(null), mutations({ a: 1, b: 2, c: 3 }));

function optional(value: { a?: number; b: number } | undefined): string {
  let result = "";
  for (const key in value) result += key;
  return result;
}
console.log("optional", optional(undefined), optional({ b: 2 }), optional({ a: 1, b: 2 }));

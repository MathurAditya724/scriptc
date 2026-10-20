// Bindings of generic overload calls: explicit type arguments name the
// overload's type parameters, which can be declared in another order than
// the implementation's, and keyof-constrained parameters bound to
// different literals through an overload read their own fields.
function tag<B, A>(value: A, label: B): string;
function tag<A, B>(value: A, label?: B): string {
  return `${typeof value}:${typeof label}:${String(value)}${String(label)}`;
}
console.log(tag<string, number>(5, "x"));
console.log(tag<boolean, string>("y", true));

class Labels {
  prefix = "#";
  render<B, A>(value: A, label: B): string;
  render<A, B>(value: A, label?: B): string {
    return `${this.prefix}${typeof value}/${typeof label}`;
  }
}
console.log(new Labels().render<number, string>("z", 7));

interface Row {
  a: number;
  b: number;
  name: string;
}
function read<T, K extends keyof T>(row: T, key: K): T[K];
function read<T, K extends keyof T>(row: T, key: K, fallback: T[K]): T[K];
function read<T, K extends keyof T>(row: T, key: K, fallback?: T[K]): T[K] {
  const value = row[key];
  return value === undefined ? fallback! : value;
}
const row: Row = { a: 1, b: 2, name: "r" };
console.log(read(row, "a"), read(row, "b"), read(row, "name"));
console.log(read(row, "b", 0) + read(row, "a", 0));

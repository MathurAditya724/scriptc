// Conditional types over function types with fixed `any` parameters, as
// a generic wrapper's specialization sees them: a function that needs
// more arguments than the pattern passes takes the false branch.
type FirstResult<F> = F extends (a: any) => infer R ? R : "takes more";
type NoArgResult<F> = F extends () => infer R ? R : "takes some";

function label<F extends (...args: any) => any>(fn: F, value: FirstResult<F>): string {
  const local: FirstResult<F> = value;
  return `${fn.name}: ${typeof local} ${String(local)}`;
}

function labelNoArgs<F extends (...args: any) => any>(fn: F, value: NoArgResult<F>): string {
  const local: NoArgResult<F> = value;
  return `${fn.name}: ${typeof local} ${String(local)}`;
}

function none(): boolean {
  return true;
}
function one(a: string): number {
  return a.length;
}
function two(a: string, b: string): number {
  return a.length + b.length;
}
function optional(a: string, b?: string): number {
  return a.length + (b?.length ?? 0);
}
function rest(a: string, ...more: string[]): number {
  return a.length + more.length;
}

console.log(label(none, true));
console.log(label(one, 3));
console.log(label(two, "takes more"));
console.log(label(optional, 4));
console.log(label(rest, 5));
console.log(labelNoArgs(none, false));
console.log(labelNoArgs(one, "takes some"));
console.log(labelNoArgs(optional, "takes some"));

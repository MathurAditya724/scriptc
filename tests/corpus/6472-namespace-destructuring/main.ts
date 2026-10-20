// Destructuring a program module's namespace, statically
// (`import * as ns`) and from a dynamic import: each element reads the
// export at the pattern's position — renames and defaults included — and
// binds a copy of its value (a later reassignment of an exported `let` is
// visible through the namespace, not through the binding).
import * as ns from "./lib.ts";

const { add, label, counter, bump, Shape: Ctor } = ns;
console.log(add(2, 3), label, counter);
bump();
console.log(counter, ns.counter);
console.log(new Ctor(4).area());

async function main(): Promise<void> {
  const { add: plus, label: name = "unused" } = await import("./lib.ts");
  console.log(plus(10, 20), name);
}

main();

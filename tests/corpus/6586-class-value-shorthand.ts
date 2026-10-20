// Object-literal shorthand of class values in TypeScript, including a
// class extending EventEmitter, and statically decided instanceof whose
// operands are computed: both operands still evaluate, left first.
import { EventEmitter } from "node:events";

const A = class {
  x = 1;
};
class B extends EventEmitter {
  n = 2;
}
class C {
  label(): string {
    return "c";
  }
}
const registry = { A, B, C };
console.log(registry.A.name, registry.B.name, registry.C.name);
console.log(new registry.A().x, new registry.B().n, new registry.C().label());
const order: string[] = [];
function make(): C {
  order.push("make");
  return new C();
}
function target(): typeof C {
  order.push("target");
  return registry.C;
}
console.log(make() instanceof target(), new registry.B() instanceof EventEmitter);
console.log(new registry.B() instanceof B, make() instanceof registry.C, order.join(","));

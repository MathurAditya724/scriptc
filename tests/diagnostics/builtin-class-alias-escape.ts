// A builtin class alias owns no runtime value in a TypeScript file:
// construction, instanceof, typeof and .name compile, other uses report
// at the use. A let binding of a class is not an alias.
import { EventEmitter } from "node:events";

const Emitter = EventEmitter;
const kinds = [Emitter];
console.log(kinds.length);

const M = Map;
const boxed: unknown = M;
console.log(boxed !== undefined);

let Mutable = EventEmitter;
console.log(typeof Mutable);

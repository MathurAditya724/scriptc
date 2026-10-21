// EventEmitter.prototype's methods read as values through untyped
// references to compiled emitters: a program class extending EventEmitter
// and `new EventEmitter()` seen through any and unknown.
import { EventEmitter } from "node:events";

class Bus extends EventEmitter {
  label = "bus";
  ping(): string {
    return `${this.label} ping`;
  }
}

const bus = new Bus();
const o: any = bus;
console.log(typeof o.on, typeof o.emit, typeof o.listeners, typeof o.ping);
console.log(o.on === o.addListener, o.off === o.removeListener, o.on === o.once);
console.log(o.on === EventEmitter.prototype.on, o.emit === EventEmitter.prototype.emit);
console.log(o.on.name, o.off.name, o.emit.name, o.once.name);
console.log(o.on.length, o.emit.length, o.listeners.length, o.eventNames.length);

// call, apply and bind with the emitter as the receiver
const add = o.on;
console.log(add.call(o, "a", (x: unknown, y: unknown) => console.log("a:", x, y)) === o);
console.log(o.emit.apply(o, ["a", 1, 2]));
const emit = o.emit.bind(o);
console.log(emit("a", "x"), emit("missing"));
console.log(o.listenerCount.call(o, "a"), o.eventNames.call(o));
const once = o.once;
once.call(o, "b", () => console.log("b once"));
console.log(emit("b"), emit("b"));
const prepend = o.prependListener;
prepend.call(o, "a", () => console.log("a first"));
emit("a", 3, 4);
console.log(Reflect.apply(o.listenerCount, o, ["a"]));

// the argument count matters to removeAllListeners and emit
o.on("c", () => {});
o.on("d", () => {});
console.log(o.removeAllListeners.call(o, "c") === o, o.eventNames());
o.removeAllListeners.call(o);
console.log(o.eventNames());
o.on("many", (...args: unknown[]) => console.log("many:", args.length, args.join(",")));
console.log(emit("many", 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11));
console.log(o.setMaxListeners.call(o, 3) === o, o.getMaxListeners.call(o));

// off through a detached method value
const listener = () => console.log("never");
o.on("e", listener);
const off = o.off;
off.call(o, "e", listener);
console.log(o.emit("e"), o.listenerCount("e"));

// membership: inherited, not own
console.log("on" in o, "emit" in o, Object.prototype.hasOwnProperty.call(o, "on"));
const key = ["emit", "listeners"][Number(o.listenerCount("a") > 5)]!;
console.log(typeof o[key], o[key] === EventEmitter.prototype.emit);

// the class's own members still answer
console.log(o.ping(), o.ping.call(o));

// new EventEmitter() through unknown
const plain = new EventEmitter();
const seen: unknown = plain;
const p = seen as any;
const pOn = p.on;
pOn.call(p, "z", (v: unknown) => console.log("z:", v));
console.log(p.emit.call(p, "z", 9), p.listeners.call(p, "z").length);
console.log(p.on === o.on, p.rawListeners === EventEmitter.prototype.rawListeners);

// a detached method called without a receiver throws a TypeError
try {
  add("x", () => {});
} catch (err) {
  console.log("detached:", err instanceof TypeError);
}

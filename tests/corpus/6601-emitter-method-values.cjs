"use strict";
// EventEmitter.prototype's methods as values in JavaScript: read off a
// compiled subclass, off `new EventEmitter()`, off EventEmitter.prototype
// by name, and shared with constructor-function emitters.
const EventEmitter = require("events");
const util = require("util");

class Queue extends EventEmitter {
  constructor() {
    super();
    this.items = [];
  }
  push(v) {
    this.items.push(v);
    this.emit("push", v);
    return this;
  }
}

const q = new Queue();
const on = q.on;
on.call(q, "push", (v) => console.log("pushed", v));
q.push(1).push(2);
for (const m of ["on", "addListener", "emit", "off", "once", "prependOnceListener", "listeners", "listenerCount", "eventNames"]) {
  console.log(m, typeof q[m], q[m] === EventEmitter.prototype[m], q[m].name, q[m].length);
}

// EventEmitter.prototype's functions called on compiled emitters
const proto = EventEmitter.prototype;
proto.on.call(q, "drain", () => console.log("drained"));
console.log(proto.emit.call(q, "drain"), proto.listenerCount.call(q, "push"));
console.log(proto.eventNames.call(q));
proto.removeAllListeners.call(q, "drain");
console.log(q.eventNames(), Reflect.apply(proto.listenerCount, q, ["drain"]));

// new EventEmitter()
const plain = new EventEmitter();
const emit = plain.emit;
plain.on("hi", (a, b, c) => console.log("hi", a, b, c));
console.log(emit.call(plain, "hi", 1, "two", [3]));
console.log(emit.call(plain, "hi", 1, 2, 3, 4));
const fn = () => console.log("never");
plain.once("x", fn);
const off = plain.off;
off.call(plain, "x", fn);
console.log(plain.emit("x"), plain.listenerCount("x"));
const bound = plain.prependListener.bind(plain);
bound("hi", () => console.log("hi first"));
plain.emit("hi", "a");

// a constructor-function emitter shares the same functions
function Legacy() {
  EventEmitter.call(this);
}
util.inherits(Legacy, EventEmitter);
const legacy = new Legacy();
console.log(legacy.on === q.on, legacy.emit === plain.emit);
legacy.on("tick", (n) => console.log("legacy tick", n));
q.on.call(legacy, "tick", (n) => console.log("legacy tick again", n));
console.log(plain.emit.call(legacy, "tick", 7), legacy.listenerCount("tick"));

// method values of a class expression whose instances escape
function makeEmitter() {
  return new (class extends EventEmitter {
    fire() {
      return this.emit("fire", "local");
    }
  })();
}
const local = makeEmitter();
const localOn = local.on;
localOn.call(local, "fire", (v) => console.log("fire", v));
console.log(local.fire(), "on" in local, Object.keys(local).includes("on"));

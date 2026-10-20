// Object-literal shorthand of class values: class declarations (plain and
// extending EventEmitter) and class expressions stored as properties. The
// property holds the class itself: construction through it, its name,
// identity with the binding, instanceof, and the emitter surface of its
// instances.
"use strict";
const { EventEmitter } = require("node:events");

class Base {
  hi() {
    return "base";
  }
}
class Bus extends EventEmitter {
  constructor(name) {
    super();
    this.name = name;
  }
}
const Anon = class extends EventEmitter {};
const api = { Base, Bus, Anon, version: 1 };
const bus = new api.Bus("main");
console.log(api.Base.name, api.Bus.name, api.Anon.name, api.version);
console.log(bus.name, bus instanceof Bus, bus instanceof EventEmitter, bus instanceof api.Bus);
console.log(new api.Base().hi(), new api.Base() instanceof Base, new api.Bus("x") instanceof Base);
bus.on("x", (v) => console.log("x", v));
console.log(bus.emit("x", 1), bus.listenerCount("x"));
const anon = new api.Anon();
console.log(anon instanceof EventEmitter, anon instanceof Anon, typeof api.Anon);
console.log(api.Bus === Bus, typeof api.Bus, Object.keys(api));

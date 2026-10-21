// EventEmitter.prototype's methods read as values from typed references
// and from EventEmitter.prototype in TypeScript.
import { EventEmitter } from "node:events";
import * as events from "node:events";

class Counter extends EventEmitter {
  count = 0;
  bump(): void {
    this.count++;
    this.emit("bump", this.count);
  }
}

const counter = new Counter();
const plain = new EventEmitter();
console.log(typeof counter.on, typeof plain.emit, typeof EventEmitter.prototype.listeners);
console.log(counter.on === plain.on, counter.addListener === EventEmitter.prototype.on);
console.log(events.EventEmitter.prototype.off === plain.removeListener);

const onValue: unknown = counter.on;
const emitValue: unknown = plain.emit;
console.log(typeof onValue, onValue === EventEmitter.prototype.addListener, emitValue === counter.emit);

const register = counter.on as any;
register.call(counter, "bump", (n: number) => console.log("bump", n));
counter.bump();
EventEmitter.prototype.on.call(counter, "bump", (n: number) => console.log("bump again", n));
counter.bump();
console.log(EventEmitter.prototype.listenerCount.call(counter, "bump"));
console.log(EventEmitter.prototype.emit.call(plain, "nothing"));

const pick = (emitter: EventEmitter, name: "on" | "emit"): unknown =>
  name === "on" ? emitter.on : emitter.emit;
console.log(pick(counter, "on") === pick(plain, "on"), pick(counter, "emit") === pick(plain, "on"));

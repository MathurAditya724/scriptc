// A MessagePort is a NodeEventTarget: on, once and addEventListener share
// one listener list per type, so a function registers once however it is
// added; on/once listeners receive the data and addEventListener listeners
// a MessageEvent, in registration order. A listener's exception is
// reported after the others run. There are no prepend methods.
import { MessageChannel } from "node:worker_threads";

process.on("uncaughtException", (error) => console.log("uncaught", error.message));
const { port1, port2 } = new MessageChannel();
console.log(typeof port1.prependListener, typeof port1.prependOnceListener, typeof port1.emit);
console.log("names", port1.eventNames(), port1.listenerCount("newListener"));

const seen = (label) => (value) => console.log(label, JSON.stringify(value));
const node = seen("node");
port1.on("message", node);
port1.on("message", node);
port1.addListener("message", node);
port1.once("message", node);
port1.addEventListener("message", node);
console.log("count after duplicates", port1.listenerCount("message"), port1.listenerCount("message", () => {}));
port1.addEventListener("message", (event) =>
  console.log("event", event.type, JSON.stringify(event.data), event.ports.length, event.target === port1),
);
port1.on("message", (value) => {
  console.log("throws", JSON.stringify(value));
  throw new Error(`listener failed on ${value.n}`);
});
port1.once("message", seen("once"));
port1.on("message", seen("last"));
console.log("count", port1.listenerCount("message"), port1.eventNames());

console.log("emit", port1.emit("message", { n: 0 }));
console.log("emit none", port1.emit("nothing", 1));
port1.on("custom", seen("custom node"));
port1.addEventListener("custom", (event) => console.log("custom event", event.type, event.detail));
port1.emit("custom", "detail");
for (const type of [5, undefined]) {
  try {
    port1.emit(type, 1);
  } catch (error) {
    console.log(error.code, error.message);
  }
}
for (const n of ["x", -1, NaN]) {
  try {
    port1.setMaxListeners(n);
  } catch (error) {
    console.log(error.code, error.message);
  }
}
port1.setMaxListeners(20);
console.log("max", port1.getMaxListeners());
try {
  port1.on("message", 5);
} catch (error) {
  console.log(error.code, error.message);
}

port2.postMessage({ n: 1 });
port2.postMessage({ n: 2 });
setTimeout(() => {
  console.log("off returns port", port1.off("message", node) === port1);
  console.log("count", port1.listenerCount("message"));
  console.log("removeAllListeners returns port", port1.removeAllListeners("custom") === port1);
  console.log("names", port1.eventNames());
  port1.removeAllListeners();
  console.log("names after all", port1.eventNames(), port1.hasRef());
  port1.close();
}, 20);

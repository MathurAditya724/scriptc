// MessagePort's onmessage and onmessageerror attributes, addEventListener
// and removeEventListener, and Node's port referencing: the first
// 'message' listener refs and starts the port, and removing the last one
// stops and unrefs it, so later messages wait for the next listener. The
// 'close' event is an Event that on() listeners receive too.
// port2 has no 'message' listener, so it does not keep the process alive.
import { MessageChannel } from "node:worker_threads";

const { port1, port2 } = new MessageChannel();
console.log("initial", port1.onmessage, port1.onmessageerror, port1.hasRef());
port1.onmessageerror = (event: MessageEvent) => console.log("messageerror", event.data);
console.log("onmessageerror set", typeof port1.onmessageerror, port1.hasRef(), port1.listenerCount("messageerror"));

let received = 0;
const onEvent = (event: Event): void => {
  const message = event as MessageEvent;
  console.log("listener", message.type, JSON.stringify(message.data), message.target === port1);
};
port1.onmessage = (event: MessageEvent) => {
  received++;
  console.log("onmessage", JSON.stringify(event.data));
  if (received === 2) {
    port1.onmessage = null;
    port1.removeEventListener("message", onEvent);
    console.log("removed", port1.onmessage, port1.listenerCount("message"), port1.hasRef());
    port2.postMessage("queued until a listener returns");
    setTimeout(resume, 10);
  }
};
port1.addEventListener("message", onEvent);
console.log("listeners", port1.listenerCount("message"), port1.hasRef());
port2.postMessage({ step: 1 });
port2.postMessage([2, "two"]);

function resume(): void {
  console.log("resuming");
  port1.on("message", (value: unknown) => {
    console.log("resumed", JSON.stringify(value));
    port1.on("close", (event: Event) => console.log("port1 close", event.type, event instanceof Event));
    port1.close(() => console.log("close callback"));
  });
}

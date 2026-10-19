// parentPort in a worker is a NodeEventTarget too: onmessage and
// addEventListener receive MessageEvents, an on() listener added twice
// runs once, and a listener's exception is reported after the others run.
// Worker objects stay EventEmitters, where on() adds a listener each time.
const { Worker, isMainThread, parentPort } = require("node:worker_threads");

if (isMainThread) {
  const worker = new Worker(__filename);
  const seen = (value) => console.log("main", JSON.stringify(value));
  worker.on("message", seen);
  worker.on("message", seen);
  console.log("worker listeners", worker.listenerCount("message"), typeof worker.prependListener);
  let replies = 0;
  worker.on("message", () => {
    if (++replies === 6) worker.postMessage("stop");
  });
  worker.on("messageerror", (error) => console.log("messageerror", error));
  worker.on("exit", (code) => console.log("exit", code, worker.listenerCount("messageerror")));
  worker.postMessage({ hello: "worker" });
} else {
  process.on("uncaughtException", (error) => parentPort.postMessage(`uncaught ${error.message}`));
  parentPort.postMessage(["in worker", parentPort.eventNames(), parentPort.hasRef(), typeof parentPort.prependListener]);
  const once = (value) => parentPort.postMessage(["on", value]);
  parentPort.on("message", once);
  parentPort.on("message", once);
  parentPort.onmessage = (event) => {
    if (event.data === "stop") {
      parentPort.onmessage = null;
      parentPort.removeAllListeners("message");
      parentPort.postMessage(["stopping", parentPort.listenerCount("message"), parentPort.hasRef()]);
      parentPort.close();
      return;
    }
    parentPort.postMessage(["onmessage", event.type, event.target === parentPort]);
    throw new Error("from onmessage");
  };
  parentPort.addEventListener("message", (event) => parentPort.postMessage(["event", event.data]));
  parentPort.postMessage(["count", parentPort.listenerCount("message"), parentPort.hasRef()]);
}

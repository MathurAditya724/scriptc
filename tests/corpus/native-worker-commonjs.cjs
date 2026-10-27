const { Worker, isMainThread, parentPort, workerData } = require("node:worker_threads");
const storedCwd = process.cwd;
if (storedCwd.name !== (isMainThread ? "wrappedCwd" : "") || storedCwd.length !== 0 ||
    storedCwd !== process.cwd || storedCwd() !== process.cwd()) {
  throw new Error("stored cwd worker metadata");
}

if (isMainThread) {
  const worker = new Worker(__filename, { workerData: 41 });
  worker.on("message", (value) => console.log("result", value));
  worker.on("exit", async (code) => {
    // A completed Worker discards even uncloneable payloads.
    worker.postMessage(() => {});
    console.log("exit", code, worker.threadId, await worker.terminate());
  });
} else {
  parentPort.postMessage(workerData + 1);
}

// The same stored cwd value has Node's main-thread or worker name,
// including when its name is read through aliases or runtime reflection.
const { Worker, isMainThread, parentPort } = require("node:worker_threads");
const processModule = require("node:process");
function snapshot() {
  const stored = process.cwd;
  const { cwd: destructured } = processModule;
  const chained = stored;
  return JSON.stringify({
    names: [
      process.cwd.name,
      processModule.cwd.name,
      stored.name,
      destructured.name,
      chained.name,
      Reflect.get(process.cwd, "name"),
      Reflect.get(stored, "name"),
      Reflect.get(chained, "name"),
    ],
    lengths: [stored.length, destructured.length],
    identity: stored === processModule.cwd && stored === destructured && stored === chained,
    directory: stored() === process.cwd(),
  });
}

if (isMainThread) {
  console.log("main", snapshot());
  const worker = new Worker(__filename);
  worker.on("message", (value) => console.log("worker", value));
  worker.on("exit", (code) => console.log("after", code, snapshot()));
} else {
  parentPort.postMessage(snapshot());
}

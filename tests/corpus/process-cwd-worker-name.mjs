// ESM imports and aliases retain cwd's name and identity in each thread.
import { Worker, isMainThread, parentPort } from "node:worker_threads";
import processDefault, { cwd } from "node:process";
import * as processModule from "node:process";

function snapshot() {
  const stored = process.cwd;
  const { cwd: destructured } = processModule;
  const chained = stored;
  return JSON.stringify({
    names: [
      process.cwd.name,
      processDefault.cwd.name,
      processModule.cwd.name,
      cwd.name,
      stored.name,
      destructured.name,
      chained.name,
      Reflect.get(cwd, "name"),
      Reflect.get(stored, "name"),
      Reflect.get(chained, "name"),
    ],
    lengths: [cwd.length, stored.length],
    identity:
      cwd === process.cwd &&
      cwd === processDefault.cwd &&
      cwd === processModule.cwd &&
      cwd === stored &&
      cwd === destructured &&
      cwd === chained,
    directory: cwd() === process.cwd(),
  });
}

if (isMainThread) {
  console.log("main", snapshot());
  const worker = new Worker(new URL("./process-cwd-worker-name.mjs", import.meta.url));
  worker.on("message", (value) => console.log("worker", value));
  worker.on("exit", (code) => console.log("after", code, snapshot()));
} else {
  parentPort.postMessage(snapshot());
}

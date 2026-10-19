// The Worker env option from CommonJS: SHARE_ENV through the module object,
// env values computed at run time, a Map (no own properties, so an empty
// environment), array-index names, a getter, and nested workers,
// which copy or share the environment of the worker that starts them.
const threads = require("node:worker_threads");
const { Worker, isMainThread, parentPort, workerData } = threads;

const keys = () =>
  Object.keys(process.env)
    .filter((k) => k.startsWith("SCRIPTC_NEST_"))
    .sort()
    .map((k) => `${k}=${process.env[k]}`)
    .join(" ");

function makeEnv(kind) {
  if (kind === "map") return new Map([["SCRIPTC_NEST_MAP", "x"]]);
  if (kind === "indices") return { 5: "x", "05": "y", 4294967295: "z", SCRIPTC_NEST_IDX: [1, 2] };
  if (kind === "getter") {
    return {
      get SCRIPTC_NEST_GET() {
        console.log("getter runs");
        return 42;
      },
    };
  }
  return { SCRIPTC_NEST_OBJ: kind };
}

if (isMainThread) {
  process.env.SCRIPTC_NEST_MAIN = "main";
  const plans = [
    ["map", makeEnv("map")],
    ["indices", makeEnv("indices")],
    ["getter", makeEnv("getter")],
    ["share-nested", threads.SHARE_ENV],
    ["copy-nested", undefined],
  ];
  let next = 0;
  const run = () => {
    if (next >= plans.length) {
      console.log("main", keys());
      return;
    }
    const [label, env] = plans[next++];
    const worker = new Worker(__filename, { env, workerData: { label, depth: 1 } });
    worker.on("message", (m) => console.log(label, m));
    worker.on("exit", () => {
      console.log(label, "main", keys());
      run();
    });
  };
  run();
} else {
  const { label, depth } = workerData;
  parentPort.postMessage(`depth ${depth}: ${keys() || "(none)"}`);
  if (label === "indices") {
    // array-index names are left out of a worker's environment
    parentPort.postMessage([process.env["5"], process.env["05"], process.env["4294967295"]]);
  }
  if (depth === 1 && label.endsWith("-nested")) {
    process.env.SCRIPTC_NEST_PARENT = String(label);
    const env = label === "share-nested" ? threads.SHARE_ENV : undefined;
    const inner = new Worker(__filename, { env, workerData: { label, depth: 2 } });
    inner.on("message", (m) => parentPort.postMessage(m));
    inner.on("exit", () => parentPort.postMessage(`after inner: ${keys()}`));
  } else if (depth === 2) {
    process.env.SCRIPTC_NEST_INNER = "inner";
  }
}

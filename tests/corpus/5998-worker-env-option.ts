// The Worker env option: by default a worker's process.env is a copy of
// its parent's; an object gives the worker its values as strings; SHARE_ENV
// has the worker and its parent use one environment. Child processes a
// worker spawns inherit the worker's process.env.
import { Worker, SHARE_ENV, isMainThread, parentPort, workerData } from "node:worker_threads";
import { exec, spawnSync } from "node:child_process";

const child = (): string =>
  spawnSync("sh", ["-c", 'printf %s "${SCRIPTC_ENV_MAIN-unset},${SCRIPTC_ENV_A-unset}"'], {
    encoding: "utf8",
  }).stdout;

if (isMainThread) {
  process.env.SCRIPTC_ENV_MAIN = "main";
  console.log(typeof SHARE_ENV, SHARE_ENV.toString(), SHARE_ENV.description, SHARE_ENV === Symbol.for("nodejs.worker_threads.SHARE_ENV"));
  function named(): number {
    return 0;
  }
  const bad: unknown[] = [1, "x", true, named, Symbol("nodejs.worker_threads.SHARE_ENV")];
  for (const env of bad) {
    try {
      const options: Record<string, unknown> = { env };
      new Worker(new URL(import.meta.url), options);
    } catch (e) {
      const err = e as Error & { code?: string };
      console.log(err.name, err.code, err.message);
    }
  }
  try {
    new Worker(new URL(import.meta.url), { env: { SCRIPTC_ENV_A: Symbol("s") } });
  } catch (e) {
    console.log((e as Error).name, (e as Error).message);
  }
  // env is checked before name.
  try {
    const options: Record<string, unknown> = { env: 1, name: 2 };
    new Worker(new URL(import.meta.url), options);
  } catch (e) {
    console.log((e as Error & { code?: string }).code, (e as Error).message.slice(0, 26));
  }
  const modes: [string, unknown][] = [
    ["default", undefined],
    ["null", null],
    ["object", { SCRIPTC_ENV_A: 1, SCRIPTC_ENV_B: true, SCRIPTC_ENV_C: null, SCRIPTC_ENV_D: { toString: () => "d" } }],
    ["share", SHARE_ENV],
    ["registered", Symbol.for("nodejs.worker_threads.SHARE_ENV")],
  ];
  let next = 0;
  const run = (): void => {
    if (next >= modes.length) {
      console.log("main done", process.env.SCRIPTC_ENV_MAIN, process.env.SCRIPTC_ENV_WORKER ?? "unset");
      return;
    }
    const [label, env] = modes[next++]!;
    process.env.SCRIPTC_ENV_MAIN = "main";
    delete process.env.SCRIPTC_ENV_WORKER;
    const options: Record<string, unknown> = { env, workerData: label };
    const worker = new Worker(new URL(import.meta.url), options);
    worker.on("message", (m: unknown) => {
      console.log(label, JSON.stringify(m));
      // a SHARE_ENV worker sees the parent's later writes
      process.env.SCRIPTC_ENV_MAIN = "changed";
      worker.postMessage("check");
    });
    worker.on("exit", () => {
      console.log(label, "main sees", process.env.SCRIPTC_ENV_MAIN, process.env.SCRIPTC_ENV_WORKER ?? "unset");
      run();
    });
  };
  run();
} else {
  const port = parentPort!;
  const before = [
    process.env.SCRIPTC_ENV_MAIN ?? "unset",
    process.env.SCRIPTC_ENV_A ?? "unset",
    process.env.SCRIPTC_ENV_B ?? "unset",
    process.env.SCRIPTC_ENV_C ?? "unset",
    process.env.SCRIPTC_ENV_D ?? "unset",
    Object.keys(process.env).filter((k) => k.startsWith("SCRIPTC_ENV_")).sort().join("|"),
    child(),
  ];
  process.env.SCRIPTC_ENV_WORKER = String(workerData);
  delete process.env.SCRIPTC_ENV_A;
  port.postMessage(before);
  port.once("message", () => {
    console.log(" ", workerData, "worker sees", process.env.SCRIPTC_ENV_MAIN ?? "unset", child());
    exec('printf %s "${SCRIPTC_ENV_WORKER-unset}"', (error: Error | null, stdout: string) => {
      console.log(" ", workerData, "exec sees", stdout);
      port.close();
    });
  });
}

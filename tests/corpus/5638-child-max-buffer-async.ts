// exec and execFile enforce maxBuffer per stream: the stream that passes
// it keeps its first maxBuffer characters, the child is killed, and the
// callback gets Node's RangeError ERR_CHILD_PROCESS_STDIO_MAXBUFFER with
// cmd (and stdout/stderr when promisified). An invalid timeout or
// maxBuffer throws synchronously, the promisified forms included.
import { exec, execFile } from "node:child_process";
import { inspect, promisify } from "node:util";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

function show(label: string, e: unknown): void {
  const err = e as { name: string; message: string; code?: string; cmd?: string; killed?: boolean; stdout?: string };
  console.log(label, err.name, err.message, err.code, err.cmd, err.killed, Object.keys(e as object).join(","));
}

async function main(): Promise<void> {
  try {
    await execFileAsync("/bin/sh", ["-c", "printf 0123456789abcdef; sleep 5"], { encoding: "utf8", maxBuffer: 10 });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    show("execFileAsync", e);
    console.log("cut", JSON.stringify(err.stdout), JSON.stringify(err.stderr));
  }
  try {
    await execAsync("printf 'abc' 1>&2; sleep 1; printf 'ok'", { encoding: "utf8", maxBuffer: 2 });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    show("execAsync", e);
    console.log("cut", JSON.stringify(err.stdout), JSON.stringify(err.stderr));
  }
  const fits = await execAsync("printf 'four'", { encoding: "utf8", maxBuffer: 4 });
  console.log("fits", JSON.stringify(fits.stdout));
  try {
    await execAsync("printf x", { encoding: "utf8", maxBuffer: 0 });
  } catch (e) {
    const err = e as { stdout?: string };
    show("zero", e);
    console.log("zero", JSON.stringify(err.stdout));
  }
  const empty = await execAsync("true", { encoding: "utf8", maxBuffer: 0 });
  console.log("empty", JSON.stringify(empty.stdout));
  // The cut counts UTF-16 code units of the chunk that passed the limit.
  try {
    await execAsync("printf 'éééééééééé'", { encoding: "utf8", maxBuffer: 5 });
  } catch (e) {
    console.log("utf8", JSON.stringify((e as { stdout?: string }).stdout));
  }
  try {
    await execAsync("echo never", { encoding: "utf8", maxBuffer: -1 });
  } catch (e) {
    show("negative", e);
  }
}

const started = Date.now();
const limit = Number(process.argv.length > 99 ? "1" : "4");
execFile("/bin/sh", ["-c", "printf 0123456789; sleep 5"], { encoding: "utf8", maxBuffer: limit }, (error, stdout, stderr) => {
  show("execFile", error);
  if (error) {
    error.stack = "";
    console.log(inspect(error));
  }
  console.log("callback", JSON.stringify(stdout), JSON.stringify(stderr), Date.now() - started < 3000);
  exec("printf hello", { encoding: "utf8", maxBuffer: 3 }, (error2, stdout2) => {
    show("exec", error2);
    console.log("callback", JSON.stringify(stdout2));
    try {
      execFile("/bin/echo", [], { encoding: "utf8", maxBuffer: 0 / 0 }, () => {
        console.log("never");
      });
    } catch (e) {
      show("nan", e);
    }
    void main().then(() => {
      console.log("prompt", Date.now() - started < 6000);
      checks();
    });
  });
});

function checks(): void {
  for (const timeout of [-1, 1.5, Infinity]) {
    try {
      void execAsync("echo never", { encoding: "utf8", timeout });
    } catch (e) {
      show("timeout", e);
    }
  }
  let n = 0;
  const order = (v: number): number => {
    console.log("arg", ++n, v);
    return v;
  };
  try {
    void execFileAsync("/bin/echo", ["never"], { encoding: "utf8", timeout: order(-2), maxBuffer: order(-3) });
  } catch (e) {
    show("order", e);
  }
}

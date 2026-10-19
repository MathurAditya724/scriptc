// The sync child_process forms enforce maxBuffer over both outputs
// together: past it the child is killed and Node's ENOBUFS spawnSync
// error is thrown, with the outputs cut at the chunk that passed it. A
// limit or timeout kill closes the pipes, so a grandchild holding one
// does not keep the call waiting.
import { execFileSync, execSync, spawnSync } from "node:child_process";

function show(label: string, e: unknown): void {
  const err = e as {
    message: string;
    code?: string;
    errno?: number;
    syscall?: string;
    status?: number | null;
    signal?: string | null;
    stdout?: string;
  };
  console.log(label, err.message, err.code, err.errno, err.syscall, err.status, err.signal);
  console.log(label, "stdout", typeof err.stdout, (err.stdout ?? "").length > 0);
}

try {
  execFileSync("/bin/sh", ["-c", "head -c 100000 /dev/zero | tr '\\0' a; sleep 5"], {
    encoding: "utf8",
    stdio: "pipe",
    maxBuffer: 1000,
  });
  console.log("no throw");
} catch (e) {
  show("execFileSync", e);
}
try {
  execSync("head -c 4000 /dev/zero | tr '\\0' b; sleep 5", { encoding: "utf8", stdio: "pipe", maxBuffer: 10 });
} catch (e) {
  show("execSync", e);
}
// Under the limit, and 0 (no limit).
const small = execSync("echo small", { encoding: "utf8", stdio: "pipe", maxBuffer: 6 });
console.log("small", JSON.stringify(small));
const big = execSync("head -c 3000000 /dev/zero | tr '\\0' c", {
  encoding: "utf8",
  stdio: "pipe",
  maxBuffer: 0,
});
console.log("unlimited", big.length);
// The default is 1 MiB.
try {
  execSync("head -c 2000000 /dev/zero | tr '\\0' d; sleep 5", { encoding: "utf8", stdio: "pipe" });
} catch (e) {
  show("default", e);
}
// A grandchild holding the pipe open does not keep the call waiting.
const started = Date.now();
try {
  execSync("head -c 5000 /dev/zero; sleep 5", { encoding: "utf8", stdio: "pipe", maxBuffer: 100 });
} catch (e) {
  show("grandchild", e);
}
console.log("prompt", Date.now() - started < 3000);
// The same after a timeout kill.
const timed = Date.now();
try {
  execSync("sleep 5; true", { encoding: "utf8", stdio: "pipe", timeout: 200 });
} catch (e) {
  show("timeout", e);
}
console.log("timeout prompt", Date.now() - timed < 3000);
// spawnSync applies the 1 MiB default.
const r = spawnSync("/bin/sh", ["-c", "head -c 2000000 /dev/zero; sleep 5"]);
console.log("spawnSync", r.status, r.signal, r.error?.message, (r.error as { code?: string } | undefined)?.code);
// A negative maxBuffer throws before anything runs.
try {
  execSync("echo never", { encoding: "utf8", maxBuffer: -1 });
} catch (e) {
  const err = e as { name: string; message: string; code?: string };
  console.log(err.name, err.code, err.message);
}

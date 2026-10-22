// spawnSync's env option replaces the child's environment, alone or with
// the other options.
import { spawnSync } from "node:child_process";

const merged = spawnSync("sh", ["-c", 'echo "$GREETING $HOME_SET"'], {
  env: { ...process.env, GREETING: "hello", HOME_SET: process.env.HOME ? "yes" : "no" },
  encoding: "utf8",
});
console.log(merged.stdout.trim(), merged.status);

const only = spawnSync("/bin/sh", ["-c", 'echo "${GREETING:-unset} ${HOME:-nohome}"'], {
  env: { GREETING: "only" },
  encoding: "utf8",
});
console.log(only.stdout.trim());

const empty = spawnSync("/bin/sh", ["-c", "env | grep -c ."], { env: {}, encoding: "utf8" });
console.log(Number(empty.stdout.trim()) <= 3, empty.status);

const quiet = spawnSync("sh", ["-c", 'echo "$MODE" >&2; exit 4'], {
  env: { PATH: process.env.PATH ?? "/usr/bin:/bin", MODE: "loud" },
  stdio: ["ignore", "pipe", "pipe"],
  timeout: 5000,
});
console.log(quiet.status, quiet.stderr.toString().trim(), quiet.stdout.toString() === "");

const missing = spawnSync("/nonexistent/tool", [], { env: { A: "1" } });
console.log(missing.status, missing.error?.message);

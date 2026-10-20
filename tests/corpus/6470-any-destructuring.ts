// Destructuring `any` values in TypeScript: a function typed to return
// `any` (an untyped command runner), an awaited `any` promise, JSON.parse,
// and an `any` table read by key all destructure through the
// checked-dynamic value, with renames, defaults, nesting, rest, holes and
// Node's TypeError for a null source.
function run(command: string): any {
  return { stdout: ` ${command} output \n`, stderr: "", exitCode: 0, meta: { pid: 42 } };
}

const { stdout, stderr } = run("echo");
console.log(JSON.stringify(stdout.toString().trim()), stderr.length);

const { exitCode: code, missing, meta: { pid }, ...rest } = run("ls");
console.log(code, missing, pid, Object.keys(rest).join(","));

const { signal = "none", exitCode = 9 } = run("true");
console.log(signal, exitCode);

const [first, , third = "default", ...others] = JSON.parse('["a", "b", null, "d", "e"]');
console.log(first, third, others.length);

const { list: [head, ...tail] } = JSON.parse('{"list":[1,2,3]}');
console.log(head, tail);

async function fetchAny(): Promise<any> {
  return { body: "payload", status: 200 };
}

async function main(): Promise<void> {
  const { body, status } = await fetchAny();
  console.log(body, status);
  const pending = fetchAny();
  const { status: again } = await pending;
  console.log(again + 1);
}

const table: any = { a: { mode: 0o755, path: "/bin" }, b: { mode: 0o644, path: "/etc" } };
for (const key in table) {
  const { mode, path } = table[key];
  console.log(key, mode.toString(8), path);
}

function lookup(found: boolean): any {
  return found ? { anything: 1 } : null;
}
for (const found of [true, false]) {
  try {
    const { anything } = lookup(found);
    console.log(anything);
  } catch (e) {
    console.log(e instanceof TypeError, (e as Error).message);
  }
}

main();

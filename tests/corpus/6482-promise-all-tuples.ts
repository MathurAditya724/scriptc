// Promise.all over an array literal of DIFFERENT promise types (the
// checker's tuple overload): destructuring with holes and nested
// patterns, void entries, plain values, `any` entries that may or may not
// hold a promise, entry identity, and rejection —
// the first rejection in settlement order wins, later ones count as
// handled.
interface Version {
  major: number;
  range: string;
}

class Scan {
  tool: string;
  schema: number | undefined;
  constructor(tool: string, schema?: number) {
    this.tool = tool;
    this.schema = schema;
  }
}

const shared: Version = { major: 22, range: "22.x" };
const scanned = new Scan("make", 9);

async function version(): Promise<Version> {
  return shared;
}
async function scan(): Promise<Scan> {
  return scanned;
}
async function patch(): Promise<void> {
  console.log("patched");
}
async function creds(ok: boolean): Promise<{ key: string } | undefined> {
  return ok ? { key: "k" } : undefined;
}
function delay<T>(ms: number, value: T, fail?: string): Promise<T> {
  return new Promise((resolve, reject) =>
    setTimeout(() => (fail ? reject(new Error(fail)) : resolve(value)), ms),
  );
}

// JavaScript-style results the checker types `any`: one holds a promise,
// one a plain value.
function untypedCount(): any {
  return 41;
}
function untypedRecord(): any {
  return Promise.resolve({ label: "from a promise" });
}

async function main(): Promise<void> {
  const [runtime, { tool: kind, schema: level }] = await Promise.all([version(), scan()]);
  console.log(runtime.major, kind, level, runtime === shared);

  const first = scan();
  const second = patch();
  const third = creds(true);
  const [found, , c] = await Promise.all([first, second, third]);
  console.log(found === scanned, c?.key);

  const both = await Promise.all([version(), 5, "x", creds(false)]);
  console.log(both[0].range, both[1] + 1, both[2], both[3]);

  const [count, { label }, plain] = await Promise.all([untypedCount(), untypedRecord(), "p"]);
  console.log(count + 1, label, plain);

  try {
    await Promise.all([delay(20, 1, "slow failure"), delay(5, "s", "fast failure"), delay(1, true)]);
  } catch (e) {
    console.log("rejected:", (e as Error).message);
  }
  await delay(40, 0);
  console.log("done");
}

main();

// Functions returning unions with reference arms where some returns are
// calls that always throw (`never`), alone and as arms of conditionals.
class Hit {
  name: string;
  constructor(name: string) {
    this.name = name;
  }
}
class Miss {
  code: number;
  constructor(code: number) {
    this.code = code;
  }
}

function fail(message: string): never {
  throw new Error(message);
}

function find(key: string, table: Map<string, Hit>): Hit | Miss {
  if (key.length === 0) return fail("empty key");
  const hit = table.get(key);
  if (hit !== undefined) return hit;
  return key.startsWith("!") ? fail("bad key " + key) : new Miss(key.length);
}

function pick(flag: number): Hit | string {
  return flag > 0 ? new Hit("p" + String(flag)) : flag < 0 ? fail("negative") : "zero";
}

function always(): Hit | Miss {
  return Math.random() < 2 ? fail("always") : fail("never reached");
}

const table = new Map([["a", new Hit("alpha")]]);
for (const key of ["a", "b", "", "!x", "long-key"]) {
  try {
    const r = find(key, table);
    console.log(key, r instanceof Hit ? r.name : r.code);
  } catch (error) {
    console.log(key, "threw", (error as Error).message);
  }
}
for (const flag of [2, 0, -1]) {
  try {
    const r = pick(flag);
    console.log(flag, typeof r === "string" ? r : r.name);
  } catch (error) {
    console.log(flag, "threw", (error as Error).message);
  }
}
try {
  always();
} catch (error) {
  console.log("always threw", (error as Error).message);
}

// Union locals bound to values that throw.
function bind(flag: number): string {
  let v: Hit | Miss = new Miss(0);
  if (flag === 1) v = fail("rebind");
  const w: Hit | Miss = flag === 2 ? fail("init") : flag > 2 ? new Miss(9) : new Hit("w");
  v = flag === 3 ? find("!y", table) : v;
  return (v instanceof Hit ? v.name : String(v.code)) + "/" + (w instanceof Hit ? w.name : "miss");
}
for (const flag of [0, 1, 2, 3]) {
  try {
    console.log("bind", flag, bind(flag));
  } catch (error) {
    console.log("bind", flag, "threw", (error as Error).message);
  }
}

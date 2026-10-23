import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { compile } from "../src/index.js";

// A package shaped like a validation library: schema classes with a virtual
// `_parse`, per-field context and result literals, a class holding the
// context, and an output object built with computed keys.
const packageSource = `
export class Status {
  constructor() { this.value = "valid"; }
  dirty() { if (this.value === "valid") this.value = "dirty"; }
}
class LazyPath {
  constructor(parent, data, key) { this.parent = parent; this.data = data; this.key = key; }
  get path() { return [this.key]; }
}
export class Base {
  constructor(def) { this._def = def; }
  ctxOf(input) { return { common: input.parent.common, data: input.data, parent: input.parent }; }
  parse(data) {
    const root = { common: { issues: [] }, data, parent: null };
    const result = this._parse({ data, parent: root });
    return result.value;
  }
}
export class Str extends Base {
  _parse(input) {
    const status = new Status();
    if (typeof input.data !== "string") status.dirty();
    return { status: status.value, value: input.data };
  }
}
export class Obj extends Base {
  _parse(input) {
    const ctx = this.ctxOf(input);
    const pairs = [];
    for (const key of Object.keys(this._def.shape)) {
      const field = this._def.shape[key];
      pairs.push({ key, value: field._parse(new LazyPath(ctx, ctx.data[key], key)) });
    }
    const out = {};
    for (const pair of pairs) out[pair.key] = pair.value.value;
    return { status: "valid", value: out };
  }
}
export const str = () => new Str({ checks: [] });
export const obj = (shape) => new Obj({ shape });
export function leak(value) { globalThis.leaked = value; return value; }
export function reflect() { const o = { a: 1 }; delete o.a; return o; }
`;

const packageTypes = `
export declare class Base { parse(data: unknown): unknown; }
export declare class Str extends Base {}
export declare class Obj extends Base {}
export declare const str: () => Str;
export declare const obj: (shape: Record<string, Base>) => Obj;
export declare function leak<T>(value: T): T;
export declare function reflect(): object;
`;

const mainSource = `
import { leak, obj, reflect, str } from "shapes-fixture";
const schema = obj({ a: str(), b: str() });
const input: unknown = JSON.parse('{"a":"x","b":"y"}');
console.log(JSON.stringify(schema.parse(input)));
console.log(JSON.stringify(leak({ kept: 1 })), JSON.stringify(reflect()));
`;

let dir: string;
let saved: string | undefined;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "scriptc-shapes-"));
  const pkg = join(dir, "node_modules", "shapes-fixture");
  await mkdir(pkg, { recursive: true });
  await writeFile(
    join(pkg, "package.json"),
    JSON.stringify({
      name: "shapes-fixture",
      version: "1.0.0",
      type: "module",
      main: "index.js",
      types: "index.d.ts",
    }),
  );
  await writeFile(join(pkg, "index.js"), packageSource);
  await writeFile(join(pkg, "index.d.ts"), packageTypes);
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ type: "module", dependencies: { "shapes-fixture": "1.0.0" } }),
  );
  await writeFile(join(dir, "main.ts"), mainSource);
  saved = process.env["SCRIPTC_DEBUG_SHAPES"];
});
afterEach(async () => {
  if (saved === undefined) delete process.env["SCRIPTC_DEBUG_SHAPES"];
  else process.env["SCRIPTC_DEBUG_SHAPES"] = saved;
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

async function report(): Promise<string[]> {
  process.env["SCRIPTC_DEBUG_SHAPES"] = "verbose";
  const lines: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    for (const l of text.split("\n")) if (l.startsWith("[shapes] ")) lines.push(l.slice(9));
    return true;
  });
  const entry = join(dir, "main.ts");
  await compile(entry, {
    outDir: dir,
    outPath: join(dir, "main.ir.json"),
    outputKind: "ir",
    npmStatic: ["shapes-fixture"],
  });
  return lines;
}

function site(lines: string[], label: RegExp): string {
  const line = lines.find((l) => l.startsWith("site ") && label.test(l));
  if (line === undefined) throw new Error(`no site ${label}:\n${lines.join("\n")}`);
  return line;
}

test("S1 report: per-field temporaries are provable records, dynamic objects stay G", async () => {
  const lines = await report();
  // result literals of both _parse implementations, the pair literal, the
  // context and the root context never escape: native records would be exact
  // the leaf schema's result: in a function called from a loop (hot)
  expect(site(lines, /^site \{status,value\}@shapes-fixture\/index\.js:23 \[hot\]/)).toMatch(
    /: P-local/,
  );
  expect(site(lines, /^site \{status,value\}@shapes-fixture\/index\.js:36/)).toMatch(/: P-local/);
  expect(site(lines, /^site \{key,value\}@/)).toMatch(/: P-local/);
  expect(site(lines, /^site \{common,data,parent\}@shapes-fixture\/index\.js:12/)).toMatch(
    /: P-local/,
  );
  expect(site(lines, /^site \[\]@shapes-fixture\/index\.js:29/)).toMatch(/: P-local/);
  // the output object is built with computed keys
  expect(site(lines, /^site \{\}@shapes-fixture\/index\.js:34/)).toMatch(/: G — computed write/);
  // a deleted key and a value stored into the global object
  expect(site(lines, /^site \{a\}@/)).toMatch(/: G — delete at/);
  expect(site(lines, /^site \{kept\}@main\.ts/)).toMatch(/: P-escaping — escapes: stored into ⊤/);
  // receiver-typed dispatch: the field's validators are the schema classes
  expect(lines.find((l) => l.startsWith("fn Str._parse@"))).toMatch(/p0=LazyPath/);
  expect(lines.find((l) => l.startsWith("class LazyPath"))).toMatch(
    /parent: \{common,data,parent\}@shapes-fixture\/index\.js:12;/,
  );
  expect(lines.find((l) => l.startsWith("class Str"))).toMatch(/_def: \{checks\}@/);
});

test("S1 report is off by default and changes nothing", async () => {
  delete process.env["SCRIPTC_DEBUG_SHAPES"];
  const writes = vi.spyOn(process.stderr, "write");
  const entry = join(dir, "main.ts");
  await compile(entry, {
    outDir: dir,
    outPath: join(dir, "main.ir.json"),
    outputKind: "ir",
    npmStatic: ["shapes-fixture"],
  });
  expect(writes.mock.calls.some(([c]) => String(c).includes("[shapes]"))).toBe(false);
});

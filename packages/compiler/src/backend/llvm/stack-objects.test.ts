import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../../index.js";
import { validateModule } from "../../ir/validate.js";
import { emitLlvmModule } from "./emitter.js";
import { addRecordResultEntries, RESULT_ENTRY_PREFIX } from "./record-results.js";

async function moduleFor(source: string) {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-stack-objects-"));
  try {
    const entry = join(dir, "main.ts"),
      output = join(dir, "main.ir.json");
    await writeFile(entry, source);
    const result = await compile(entry, { outDir: dir, outPath: output, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((item) => `${item.code}: ${item.message}`).join("\n"));
    const module = deserializeModule(await readFile(output, "utf8"));
    expect(validateModule(module)).toEqual([]);
    return module;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The body of a source function: its borrowing or i32 entry when it has one. */
function body(ir: string, name: string): string {
  return new RegExp(`^define internal [^\\n]*@sc_b?f_${name}(?:\\.i32)?\\([^]*?^}`, "m").exec(
    ir,
  )![0];
}

const VECTORS = `
interface Vec { x: number; y: number }
function add(a: Vec, b: Vec): Vec { return { x: a.x + b.x, y: a.y + b.y }; }
function dot(a: Vec, b: Vec): number { return a.x * b.x + a.y * b.y; }
function shortest(a: Vec): Vec { return a.x < a.y ? { x: a.x, y: 0 } : { x: 0, y: a.y }; }
const kept: Vec[] = [];
export function projected(n: number): number {
  const p = { x: n, y: 1 };
  const q = add(p, { x: 2, y: n });
  return dot(q, p) + dot(shortest(q), q);
}
export function escaping(n: number): number {
  const p = { x: n, y: 1 };
  kept.push(p);
  const q = add(p, p);
  kept.push(q);
  return q.x;
}
export function reassigned(n: number): number {
  let p = { x: n, y: 0 };
  for (let i = 0; i < n; i++) p = add(p, { x: 1, y: i });
  return p.x + p.y;
}
console.log(projected(2), escaping(3), reassigned(4), kept.length);
`;

test("projection-only records live in frame storage and producers fill it", async () => {
  const ir = emitLlvmModule(await moduleFor(VECTORS));
  const projected = body(ir, "projected");
  expect(projected).toMatch(/alloca %sc_rs_\w+, align 8/);
  expect(projected).toContain("store i64 -1, ptr");
  expect(projected).not.toMatch(/@sc_rnew_/);
  expect(projected).toMatch(/call void @sc_\w*into_add\(/);
  expect(projected).toMatch(/call void @sc_\w*into_shortest\(/);
  // A literal stores every field: its storage is not zeroed first.
  expect(projected).not.toContain("zeroinitializer");
  // Stored values keep the heap path and the ordinary producer.
  const escaping = body(ir, "escaping");
  expect(escaping).toMatch(/call ptr @sc_rnew_/);
  expect(escaping).toMatch(/call ptr @sc_\w*f_add\(/);
  expect(escaping).not.toMatch(/alloca %sc_rs_/);
});

test("reassigned bindings build each value apart and copy it into their slot", async () => {
  const ir = emitLlvmModule(await moduleFor(VECTORS));
  const reassigned = body(ir, "reassigned");
  expect(reassigned).not.toMatch(/@sc_rnew_/);
  expect(reassigned).toMatch(/load %sc_rs_\w+, ptr %s\d+\n\s+store %sc_rs_\w+ %t\d+, ptr %s\d+/);
});

test("result-slot entries cover producers whose every return is fresh", async () => {
  const mod = await moduleFor(`
interface Vec { x: number; y: number }
function fresh(n: number): Vec { if (n > 1) return { x: n, y: n }; return { x: 0, y: 1 }; }
function passthrough(v: Vec): Vec { return v; }
function guarded(n: number): Vec { try { return { x: n, y: 0 }; } finally { console.log(n); } }
console.log(fresh(1).x, passthrough({ x: 1, y: 2 }).y, guarded(3).x);
`);
  const entries = addRecordResultEntries(mod)
    .functions.map((fn) => fn.name)
    .filter((name) => name.startsWith(RESULT_ENTRY_PREFIX));
  expect(entries).toEqual([`${RESULT_ENTRY_PREFIX}fresh`]);
});

test("objects stay on the heap when their constructor or a method lets them escape", async () => {
  const ir = emitLlvmModule(
    await moduleFor(`
const seen: Tracked[] = [];
class Tracked { id: number; constructor(id: number) { this.id = id; seen.push(this); } }
class Plain {
  a: number; b: number;
  constructor(a: number, b: number) { this.a = a; this.b = b; }
  sum(): number { return this.a + this.b; }
  self(): Plain { return this; }
}
const selves: Plain[] = [];
export function run(n: number): number {
  const t = new Tracked(n);
  const p = new Plain(n, 1);
  const s = new Plain(n, 2);
  selves.push(s.self());
  return t.id + p.sum() + s.sum();
}
console.log(run(1), seen.length, selves.length);
`),
  );
  const run = body(ir, "run");
  expect(run.match(/alloca %sc_o_\w+, align 8/g)).toHaveLength(1);
  expect(run).toContain("call ptr @sc_new_Tracked()");
  expect(run).toContain("call ptr @sc_new_Plain()");
});

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../src/index.js";
import type { IrExpr, IrFunction, IrModule, IrStmt } from "../src/ir/ir.js";
import { everyStmtList } from "../src/ir/traverse.js";
import type { TierMode } from "../src/frontend/tier-analysis.js";

async function lowerSource(source: string, tier?: TierMode): Promise<IrModule> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-cast-fallback-"));
  try {
    const entry = join(dir, "main.ts");
    await writeFile(entry, source);
    const outPath = join(dir, "main.ir.json");
    const result = await compile(entry, {
      outPath,
      outDir: dir,
      outputKind: "ir",
      ...(tier ? { tier } : {}),
    });
    if (!result.ok) throw new Error(result.diagnostics.map((d) => d.message).join("\n"));
    return deserializeModule(await readFile(outPath, "utf8"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function fnNamed(mod: IrModule, name: string): IrFunction {
  const fn = mod.functions.find((f) => f.name === name);
  if (!fn) throw new Error(`no function ${name}`);
  return fn;
}

function checks(fn: IrFunction): (IrExpr & { kind: "dynCheck" })[] {
  const found: (IrExpr & { kind: "dynCheck" })[] = [];
  everyStmtList(fn.body, {
    expr: (e) => {
      if (e.kind === "dynCheck") found.push(e);
      return true;
    },
    stmt: () => true,
  });
  return found;
}

/** The `if (flag) dynamic else static` split a fallback tail lowers to. */
function splits(fn: IrFunction): (IrStmt & { kind: "if" })[] {
  const found: (IrStmt & { kind: "if" })[] = [];
  everyStmtList(fn.body, {
    expr: () => true,
    stmt: (s) => {
      if (
        s.kind === "if" &&
        s.cond.kind === "varRef" &&
        s.cond.localId.startsWith("%fb.") &&
        s.else_ !== null
      )
        found.push(s);
      return true;
    },
  });
  return found;
}

const listener = `
interface Order { deployment: { id: string; plan: string } }
interface Req { buildOrder: Order; traceCarrier?: Record<string, string> }
function accept(body: string): string {
  let request: Partial<Req>;
  try {
    request = JSON.parse(body) as Partial<Req>;
  } catch {
    return "400";
  }
  const id = request.buildOrder?.deployment?.id;
  return id ? "200 " + id : "400 missing";
}
console.log(accept('{"buildOrder":{"deployment":{"id":"d"}}}'));
`;

test("a block-local checked cast continues in a dynamic tail behind one flag", async () => {
  const fn = fnNamed(await lowerSource(listener), "accept");
  const [check] = checks(fn);
  expect(check?.fallback).toBe(true);
  const split = splits(fn);
  expect(split).toHaveLength(1);
  // The static tail reads the record natively; the dynamic one reads the
  // failed value's shadow.
  const shadowReads = (body: IrStmt[]): number => {
    let n = 0;
    everyStmtList(body, {
      expr: (e) => {
        if (e.kind === "varRef" && e.localId.startsWith("%fbv.")) n++;
        return true;
      },
      stmt: () => true,
    });
    return n;
  };
  expect(shadowReads(split[0]!.then)).toBeGreaterThan(0);
  expect(shadowReads(split[0]!.else_!)).toBe(0);
});

test("--tier=static-only keeps the throwing cast", async () => {
  const fn = fnNamed(await lowerSource(listener, "static-only"), "accept");
  expect(checks(fn).some((c) => c.fallback)).toBe(false);
  expect(splits(fn)).toHaveLength(0);
  expect(fn.locals.some((l) => l.id.startsWith("%fb"))).toBe(false);
});

test("casts whose binding is read outside the code after them, or written again, keep throwing", async () => {
  const mod = await lowerSource(`
interface P { x: number }
const top = JSON.parse('{"x":1}') as P;
console.log(top.x);
function before(text: string): number {
  let p: P | undefined;
  for (let i = 0; i < 2; i++) {
    if (p) console.log(p.x);
    p = JSON.parse(text) as P;
  }
  return p?.x ?? 0;
}
function rewritten(text: string): number {
  let p = JSON.parse(text) as P;
  p = { x: 2 };
  return p.x;
}
function hoisted(text: string): number {
  const p = JSON.parse(text) as P;
  function read(): number { return p.x; }
  return read();
}
console.log(before('{"x":1}'), rewritten('{"x":1}'), hoisted('{"x":1}'));
`);
  for (const name of ["before", "rewritten", "hoisted"]) {
    const fn = fnNamed(mod, name);
    expect(
      checks(fn).some((c) => c.fallback),
      name,
    ).toBe(false);
    expect(
      fn.locals.some((l) => l.id.startsWith("%fb")),
      name,
    ).toBe(false);
  }
  expect(mod.functions.flatMap(checks).some((c) => c.fallback)).toBe(false);
});

test("sequential casts split the code after them at most twice", async () => {
  const source = `
interface P { x: number }
function sum(a: string, b: string, c: string, d: string): number {
  const p = JSON.parse(a) as P;
  const q = JSON.parse(b) as P;
  const r = JSON.parse(c) as P;
  const s = JSON.parse(d) as P;
  return p.x + q.x + r.x + s.x;
}
console.log(sum('{"x":1}', '{"x":2}', '{"x":3}', '{"x":4}'));
`;
  const fn = fnNamed(await lowerSource(source), "sum");
  // p splits the code after it, and q splits each copy of that code; r and
  // s keep the throwing cast instead of doubling the copies again.
  expect(splits(fn)).toHaveLength(3);
  const binding = (c: { loc: { start: number } }) =>
    /const (\w) = [^\n]*$/.exec(source.slice(0, c.loc.start))?.[1];
  const casts = checks(fn);
  expect(new Set(casts.filter((c) => c.fallback).map(binding))).toEqual(new Set(["p", "q"]));
  expect(new Set(casts.filter((c) => !c.fallback).map(binding))).toEqual(new Set(["r", "s"]));
});

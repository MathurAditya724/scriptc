/* Inheritance codegen guarantees that are scriptc-only by nature —
 * deliberately NOT in the differential corpus (behavior is; these pin the
 * COST model):
 *
 * - Zero-cost standalone classes: a program whose classes never extend
 *   must emit no vtable machinery at all — no vtable word, no ScrVt, no
 *   dynamic dispatch. The "inheritance costs nothing until you use it"
 *   claim, machine-enforced.
 * - Whole-program devirtualization: inside a hierarchy, a method nobody
 *   overrides keeps the direct static call (and gets no vtable slot);
 *   only genuinely-overridden methods dispatch through the vtable.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const repoRoot = join(import.meta.dirname, "../..");
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests");
const sanitize = process.env["SCRIPTC_SAN"] === "1";

/** Compiles an inline program and returns the emitted LLVM text. */
async function emittedLlvm(name: string, source: string, ext = "ts"): Promise<string> {
  const key = createHash("sha256")
    .update(source)
    .update(sanitize ? "san" : "plain")
    .digest("hex")
    .slice(0, 16);
  const outDir = join(cacheDir, `inh-${key}`);
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `${name}.${ext}`);
  writeFileSync(file, source);
  // Inspect LLVM directly so the cost model is independent of optimization.
  const result = await compile(file, {
    outPath: join(outDir, name),
    outDir,
    sanitize,
    backend: "llvm",
    outputKind: "llvm",
  });
  if (!result.ok) {
    throw new Error(
      "inheritance program failed to compile:\n" +
        result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"),
    );
  }
  return readFileSync(result.artifact.path, "utf8");
}

describe("inheritance codegen", () => {
  test("standalone classes emit no vtable machinery", async () => {
    const llvm = await emittedLlvm(
      "standalone",
      `class Point {
  x: number;
  constructor(x: number) {
    this.x = x;
  }
  norm(): number {
    return this.x * this.x;
  }
}
const p = new Point(3);
console.log(p.norm());
`,
    );
    expect(llvm).not.toMatch(/%sc_vtt_(?:Point|Gauge)\b/);
    expect(llvm).not.toContain("sc_vtable_");
  });

  test("a never-overridden method in a hierarchy stays a direct call", async () => {
    const llvm = await emittedLlvm(
      "devirt",
      `class Animal {
  name: string;
  constructor(name: string) {
    this.name = name;
  }
  id(): string {
    return this.name; // never overridden: no slot, direct calls
  }
  speak(): string {
    return "..."; // overridden below: vtable slot, dynamic calls
  }
}
class Dog extends Animal {
  speak(): string {
    return "woof";
  }
}
const a: Animal = new Dog("rex");
const b: Animal = new Animal("cat");
console.log(a.id(), a.speak(), b.speak());
`,
    );
    // The devirtualized call is a direct sc_f_ call of Animal's id...
    expect(llvm).toMatch(/sc_f__x25_Animal_id\(/);
    // ...and id never becomes a vtable slot, while speak does and the
    // base-typed call site dispatches through it.
    expect(llvm).toMatch(/%sc_vtt_Animal = type \{ %ScrVt, ptr \}/);
    expect(llvm).toMatch(/@sc_vtable_Dog = [^\n]*ptr @sc_b?f__x25_Dog_speak\b/);
    expect(llvm).toMatch(
      /getelementptr inbounds %sc_vtt_Animal, ptr %\w+, i64 0, i32 1[\s\S]*call ptr %\w+\(ptr /,
    );
  });

  test("accessors on standalone classes stay zero-cost direct calls", async () => {
    const llvm = await emittedLlvm(
      "accessor-standalone",
      `class Gauge {
  _level: number;
  constructor() {
    this._level = 0;
  }
  get level(): number {
    return this._level;
  }
  set level(v: number) {
    this._level = v;
  }
}
const g = new Gauge();
g.level = 5;
g.level += 2;
console.log(g.level);
`,
    );
    expect(llvm).not.toMatch(/%sc_vtt_(?:Point|Gauge)\b/);
    expect(llvm).not.toContain("sc_vtable_");
    // Reads and writes are direct calls of the accessor functions
    // ("get:level" mangles ':' as _x3a_).
    expect(llvm).toMatch(/sc_f__x25_Gauge_get_x3a_level\(/);
    expect(llvm).toMatch(/sc_f__x25_Gauge_set_x3a_level\(/);
  });

  test("the get and set halves of accessors devirtualize independently", async () => {
    const llvm = await emittedLlvm(
      "accessor-devirt",
      `class Cell {
  _v: number;
  constructor() {
    this._v = 0;
  }
  get v(): number {
    return this._v; // pair, never overridden: no slots, direct calls
  }
  set v(x: number) {
    this._v = x;
  }
  get label(): string {
    return "cell"; // getter-only, overridden below: vtable slot
  }
}
class LoudCell extends Cell {
  get label(): string {
    return "LOUD " + this._v;
  }
}
const c: Cell = new LoudCell();
const plain: Cell = new Cell();
c.v = 3;
console.log(c.v, c.label, plain.label);
`,
    );
    // The overridden getter dispatches through its slot...
    expect(llvm).toMatch(/%sc_vtt_Cell = type \{ %ScrVt, ptr \}/);
    expect(llvm).toMatch(/@sc_vtable_LoudCell = [^\n]*ptr @sc_b?f__x25_LoudCell_get_x3a_label\b/);
    expect(llvm).toMatch(
      /getelementptr inbounds %sc_vtt_Cell, ptr %\w+, i64 0, i32 1[\s\S]*call ptr %\w+\(ptr /,
    );
    // ...while the never-overridden pair keeps direct calls and no slots.
    expect(llvm).toMatch(/sc_f__x25_Cell_get_x3a_v\(/);
    expect(llvm).toMatch(/sc_f__x25_Cell_set_x3a_v\(/);
  });

  test("a stream subclass embeds the ScrStream prefix and delegates its state RC", async () => {
    const llvm = await emittedLlvm(
      "stream-subclass",
      `import { Readable } from "node:stream";
class Counter extends Readable {
  n = 0;
  _read(): void {
    this.n++;
    this.push(this.n <= 2 ? String(this.n) : null);
  }
}
const r = new Counter();
r.on("data", (b: Buffer) => console.log(b.toString()));
`,
    );
    // The subclass struct carries the full ScrStream prefix (registry,
    // display name, state pointer) ahead of user fields...
    expect(llvm).toContain("%sc_o_Counter = type { i64, ptr, ptr, ptr, ptr, double }");
    // ...its teardown delegates the state block to the runtime...
    expect(llvm).toMatch(
      /getelementptr inbounds %sc_o_Counter, ptr %o, i64 0, i32 4[\s\S]*call void @scr_stream_st_release\(ptr /,
    );
    // ...and super() initializes the state over the allocated struct.
    expect(llvm).toContain("call void @scr_stream_init_readable(ptr ");
  });

  test("a runtime-fenced nested stream class emits the refusal without class helpers", async () => {
    // The phase-1 reachable bug: a class declared inside a block (a
    // runtime fence in JS) whose instances are captured emitted capture-
    // box RC adapters for the uncollected class — a C compile error.
    // run()'s unregistered-class sweep now rewrites such type slots to
    // the inert f64 placeholder before emission (no instance can exist;
    // every use traps), so the capture box is a PLAIN-kind box and the
    // class never reaches the emitter at all.
    const llvm = await emittedLlvm(
      "stream-nested-fence",
      `const { Readable } = require("stream");
{
  class R extends Readable {
    _read() { this.push(null); }
  }
  function onRead() { stream.read(); }
  const stream = new R();
  stream.once("readable", onRead);
}
`,
      "js",
    );
    expect(llvm).not.toContain("sc_retain_R_v");
    expect(llvm).not.toContain("uncollected class");
    expect(llvm).not.toContain("%sc_o_R");
    expect(llvm).toMatch(/%sc_l_stream_0 = alloca ptr/);
    expect(llvm).toContain("call void @scr_throw_error_msg_code");
  });

  test("a getter-only override of a pair fills the set slot with a thrower", async () => {
    const llvm = await emittedLlvm(
      "accessor-shadow",
      `class Box {
  _v: number;
  constructor() {
    this._v = 1;
  }
  get v(): number {
    return this._v;
  }
  set v(x: number) {
    this._v = x;
  }
}
class SealedBox extends Box {
  get v(): number {
    return 42;
  }
}
const b: Box = new SealedBox();
const plain: Box = new Box();
try {
  b.v = 9;
} catch {
  console.log("sealed");
}
plain.v = 2;
console.log(b.v, plain.v);
`,
    );
    // JS shadowing: the derived class's synthesized setter occupies the
    // set slot (a base-typed write must throw like Node), so BOTH halves
    // dispatch dynamically here.
    expect(llvm).toMatch(/%sc_vtt_Box = type \{ %ScrVt, ptr, ptr \}/);
    expect(llvm).toMatch(
      /@sc_vtable_SealedBox = [^\n]*ptr @sc_b?f__x25_SealedBox_get_x3a_v(\.virtual)?, ptr @sc_b?f__x25_SealedBox_set_x3a_v\b/,
    );
    expect(llvm).toMatch(/getelementptr inbounds %sc_vtt_Box, ptr %\w+, i64 0, i32 2/);
    expect(llvm).toMatch(/sc_f__x25_SealedBox_set_x3a_v/);
  });
});

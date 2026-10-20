import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { analyzeWasm } from "./binary.js";
import { decodeBase64, encodeBase64 } from "./base64.js";
import { WasmCursor, parseWasmModule } from "./module.js";
import {
  signatureHash,
  stackCheckedFunctions,
  translateWasmModule,
  wasmSymbolPrefix,
} from "./translate.js";

const SHA = new Uint8Array(32).fill(0xab);

/** (module (func (export "add") (param i32 i32) (result i32) local.get 0 local.get 1 i32.add)
 *  (memory (export "mem") 1) (data (i32.const 8) "hi")) */
const ADD = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 7, 1, 96, 2, 127, 127, 1, 127, 3, 2, 1, 0, 5, 3, 1, 0, 1, 7, 13,
  2, 3, 97, 100, 100, 0, 0, 3, 109, 101, 109, 2, 0, 10, 9, 1, 7, 0, 32, 0, 32, 1, 106, 11, 11, 8, 1,
  0, 65, 8, 11, 2, 104, 105,
]);

/** Every top-level line must be one the native helper's text partitioner
 * accepts (native/llvm-codegen/src/partition.cpp), so translated modules
 * keep the program on its concurrent parsing path. */
function topLevelLines(text: string[]): string[] {
  const lines: string[] = [];
  for (const part of text) {
    let inFunction = false;
    for (const line of part.split("\n")) {
      if (inFunction) {
        if (line === "}") inFunction = false;
        continue;
      }
      if (line.startsWith("define ")) inFunction = true;
      lines.push(line);
    }
  }
  return lines;
}

describe("translateWasmModule", () => {
  test("emits functions, thunks, data and the descriptor in the helper's grammar", () => {
    const out = translateWasmModule(ADD, SHA, { boundsChecks: false });
    const prefix = wasmSymbolPrefix(SHA);
    expect(prefix).toBe("scr_wasm_abababababababab");
    expect(out.descriptor).toBe(`@${prefix}_desc`);
    const text = out.text.join("\n");
    expect(text).toContain(`define internal i32 @${prefix}_f0(ptr %inst, i32 %p0, i32 %p1)`);
    expect(text).toContain(`define internal void @${prefix}_x0(ptr %inst, ptr %a, ptr %r)`);
    expect(text).toContain(`c"hi"`);
    expect(text).toContain(`"disable-tail-calls"="true"`);
    for (const line of topLevelLines(out.text)) {
      expect(
        line === "" || /^(define internal |@[\w.$-]+ = (private|internal) )/.test(line),
        line,
      ).toBe(true);
    }
    for (const decl of out.decls) expect(decl).toMatch(/^declare /);
  });

  test("keeps custom sections only when asked, and gives unexported table functions call thunks", () => {
    // (module (type $t (func (param i32) (result i32))) (table 2 funcref)
    //   (elem (i32.const 0) $hidden $shown) (func $hidden (type $t) local.get 0)
    //   (func $shown (export "shown") (type $t) local.get 0)), plus a custom
    //   section "meta" with "hi".
    const refs = new Uint8Array([
      0, 97, 115, 109, 1, 0, 0, 0, 1, 6, 1, 96, 1, 127, 1, 127, 3, 3, 2, 0, 0, 4, 4, 1, 112, 0, 2,
      7, 9, 1, 5, 115, 104, 111, 119, 110, 0, 1, 9, 8, 1, 0, 65, 0, 11, 2, 0, 1, 10, 11, 2, 4, 0,
      32, 0, 11, 4, 0, 32, 0, 11, 0, 7, 4, 109, 101, 116, 97, 104, 105,
    ]);
    const prefix = wasmSymbolPrefix(SHA);
    const plain = translateWasmModule(refs, SHA, { boundsChecks: false }).text.join("\n");
    expect(plain).toContain(
      `@${prefix}_customs = private constant [0 x { ptr, i64, ptr, i64 }] []`,
    );
    expect(plain).not.toContain(`c"hi"`);
    const kept = translateWasmModule(refs, SHA, { boundsChecks: false, customSections: true });
    const text = kept.text.join("\n");
    expect(text).toContain(`@${prefix}_c0 = private unnamed_addr constant [2 x i8] c"hi", align 1`);
    expect(text).toContain(`@${prefix}_customs = private constant [1 x { ptr, i64, ptr, i64 }]`);
    // One call thunk for the signature, used by the unexported function
    // only (the exported one has its export thunk).
    expect(text).toContain(
      `define internal void @${prefix}_k0(ptr %code, ptr %inst, ptr %a, ptr %r)`,
    );
    expect(text).toContain(`%res = call i32 %code(ptr %inst, i32 `);
    expect(text).toContain(
      `@${prefix}_calls = private constant [2 x ptr] [ptr @${prefix}_k0, ptr null]`,
    );
    for (const line of topLevelLines(kept.text)) {
      expect(
        line === "" || /^(define internal |@[\w.$-]+ = (private|internal) )/.test(line),
        line,
      ).toBe(true);
    }
  });

  test("checks memory accesses explicitly only when asked", () => {
    const guarded = translateWasmModule(ADD, SHA, { boundsChecks: false }).text.join("\n");
    const checked = translateWasmModule(ADD, SHA, { boundsChecks: true }).text.join("\n");
    expect(guarded).not.toContain("%msize");
    expect(checked).toContain("%msize");
  });

  test("translates every valid module of the WebAssembly spec test suite", () => {
    const cases = readFileSync(join(import.meta.dirname, "../../test/wasm-spec-cases.txt"), "utf8")
      .split("\n")
      .filter((line) => line !== "" && !line.startsWith("#"));
    let translated = 0;
    for (const line of cases) {
      const [, , where, b64] = line.split(" ");
      const bytes = decodeBase64(b64!)!;
      if (analyzeWasm(bytes).status !== "valid") continue;
      try {
        translateWasmModule(bytes, SHA, { boundsChecks: false });
      } catch (error) {
        throw new Error(`${where}: ${error instanceof Error ? error.message : String(error)}`);
      }
      translated++;
    }
    expect(translated).toBeGreaterThan(800);
  });
});

describe("module parsing", () => {
  test("reads the parts translation needs", () => {
    const m = parseWasmModule(ADD);
    expect(m.types).toEqual([{ params: [0x7f, 0x7f], results: [0x7f] }]);
    expect(m.exports.map((e) => e.name)).toEqual(["add", "mem"]);
    expect(m.memories).toEqual([{ min: 1, max: null, imported: false }]);
    expect(m.datas[0]!.mode).toBe("active");
    expect([...m.declaredRefs]).toEqual([0]);
  });

  test("decodes signed 64-bit LEB128 into two's-complement halves", () => {
    const halves = (bytes: number[]): [number, number] =>
      new WasmCursor(new Uint8Array(bytes), 0).s64();
    expect(halves([0x7f])).toEqual([0xffffffff, 0xffffffff]);
    expect(halves([0x80, 0x80, 0x80, 0x80, 0x10])).toEqual([0, 1]);
    expect(halves([0xff, 0xff, 0xff, 0xff, 0x0f])).toEqual([0xffffffff, 0]);
    expect(halves([0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x7f])).toEqual([
      0, 0x80000000,
    ]);
    expect(halves([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00])).toEqual([
      0xffffffff, 0x7fffffff,
    ]);
  });
});

describe("stack checks", () => {
  test("only functions through which the stack can grow without bound check it", () => {
    // f0 <-> f1 recurse mutually, f2 recurses on itself, f3 calls f0 once.
    const calls = new Uint8Array([
      0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 5, 4, 0, 0, 0, 0, 10, 21, 4, 4, 0, 16, 1,
      11, 4, 0, 16, 0, 11, 4, 0, 16, 2, 11, 4, 0, 16, 0, 11,
    ]);
    expect([...stackCheckedFunctions(parseWasmModule(calls))].sort()).toEqual([0, 1, 2]);
    expect(stackCheckedFunctions(parseWasmModule(ADD)).size).toBe(0);
    // Only code without the fault handler checks explicitly.
    const checked = translateWasmModule(calls, SHA, { boundsChecks: true }).text.join("\n");
    expect(checked.split("@scr_wasm_stack_limit").length - 1).toBe(3);
    const guarded = translateWasmModule(calls, SHA, { boundsChecks: false }).text.join("\n");
    expect(guarded).not.toContain("@scr_wasm_stack_limit");
  });
});

describe("helpers", () => {
  test("equal signatures share their identity across modules", () => {
    expect(signatureHash("ii:i")).toBe(signatureHash("ii:i"));
    expect(signatureHash("ii:i")).not.toBe(signatureHash("i:i"));
    expect(signatureHash(":")).toMatch(/^u0x[0-9a-f]{16}$/);
  });

  test("base64 round-trips module bytes", () => {
    expect(encodeBase64(ADD)).toBe(Buffer.from(ADD).toString("base64"));
    expect(decodeBase64(encodeBase64(ADD))).toEqual(ADD);
    expect(encodeBase64(new Uint8Array([1]))).toBe("AQ==");
    expect(encodeBase64(new Uint8Array([1, 2]))).toBe("AQI=");
  });
});

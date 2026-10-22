import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import * as ast from "../ts7/ast.js";
import * as ts from "../ts7/adapter.js";
import { Ts7Host } from "../ts7/program-host.js";
import { Ts7Api } from "../ts7/rpc-api.js";
import { Lowerer } from "./lowerer.js";
import { earlyReadVarSymbols } from "./var-hoisting.js";

function fixture(source: string) {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-hoisting-references-"));
  const entry = join(directory, "main.cjs");
  writeFileSync(entry, source);
  const host = new Ts7Host((options) => new Ts7Api(options), { cwd: directory });
  const program = host.createProgram([entry], {
    noLib: true,
    types: [],
    strict: true,
    allowJs: true,
    checkJs: true,
  });
  const file = program.getSourceFile(entry)!;
  const lowerer = new Lowerer(program, file, [file]);
  const analyze = () => earlyReadVarSymbols(lowerer, [file]);
  const early = () => {
    const result = analyze();
    const names: string[] = [];
    ts.walkPreorder(file, (node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
        const symbol = lowerer.checker.getSymbolAtLocation(node.name);
        if (symbol !== undefined && result.has(symbol)) names.push(node.name.text);
      }
    });
    return names;
  };
  return {
    file,
    analyze,
    early,
    dispose() {
      program.dispose();
      host.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("whole-file reference scans do not grow with the number of functions", () => {
  const fixtures = [12, 48].map((count) =>
    fixture(
      "var value = 7;\nfunction f0() { return value; }\n" +
        Array.from({ length: count }, (_, i) => `function f${i + 1}() { return f${i}(); }\n`).join(
          "",
        ) +
        `f${count}();\n`,
    ),
  );
  const walk = vi.spyOn(ast, "walkPreorder");
  try {
    const scans = fixtures.map((f) => {
      walk.mockClear();
      expect(f.analyze().size).toBe(0);
      return walk.mock.calls.filter(([node]) => node === f.file).length;
    });
    expect(scans[0]).toBeGreaterThan(0);
    expect(scans[1]).toBe(scans[0]);
  } finally {
    walk.mockRestore();
    for (const f of fixtures) f.dispose();
  }
});

test("reference indexing preserves shadowed function names and early calls", () => {
  const f = fixture(`
function read() { return late; }
read();
var late = 7;
var settled = 8;
function holder() {
  function read() { return settled; }
  return read();
}
holder();
`);
  try {
    expect(f.early()).toEqual(["late"]);
  } finally {
    f.dispose();
  }
});

test("reference indexes belong to each immutable source file snapshot", () => {
  const before = fixture("var value = 7; function read() { return value; } read();\n");
  const after = fixture("read(); var value = 7; function read() { return value; }\n");
  try {
    expect(before.early()).toEqual([]);
    expect(after.early()).toEqual(["value"]);
    expect(before.early()).toEqual([]);
  } finally {
    before.dispose();
    after.dispose();
  }
});

test("duplicate declarations and shorthand references retain symbol identity", () => {
  const duplicate = fixture(`
function read() { return first; }
function read() { return second; }
read();
var first = 7;
var second = 8;
`);
  const shorthand = fixture(`
var object = { read };
object.read();
var value = 7;
function read() { return value; }
`);
  try {
    expect(duplicate.early()).toEqual(["first", "second"]);
    expect(shorthand.early()).toEqual(["value"]);
  } finally {
    duplicate.dispose();
    shorthand.dispose();
  }
});

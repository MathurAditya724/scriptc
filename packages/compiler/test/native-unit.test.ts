import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { nameCounter } from "../src/native-unit/emit.js";
import { compileNativeUnit, nativeProbeSource } from "../src/native-unit/index.js";
import { parseProbe } from "../src/native-unit/probe.js";

/* Native units (src/native-unit): the probe, the IR shapes of the lowering
 * rules, the refusals, and the object gate for scr_key.ts against the C
 * definitions it replaces. The probe and objects are built with the host
 * clang and the runtime's C flags. */

const runtimeSrc = join(import.meta.dirname, "../../runtime/src");
const fixtures = join(import.meta.dirname, "native-unit");
const C_FLAGS = [
  "-std=c11",
  "-fno-math-errno",
  "-fno-strict-aliasing",
  "-D_GNU_SOURCE",
  "-O2",
  "-g0",
];

let dir: string;
let probe: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "scriptc-native-unit-"));
  writeFileSync(join(dir, "probe.c"), nativeProbeSource());
  execFileSync("clang", [
    ...C_FLAGS,
    "-S",
    "-emit-llvm",
    "-Xclang",
    "-disable-llvm-passes",
    join(dir, "probe.c"),
    "-o",
    join(dir, "probe.ll"),
  ]);
  probe = readFileSync(join(dir, "probe.ll"), "utf8");
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function compileFixture(file: string): string {
  const result = compileNativeUnit(join(fixtures, file), { probe });
  expect(result.diagnostics.map((d) => d.message)).toEqual([]);
  return result.llvm!;
}

/** The text of one function definition. */
function definition(llvm: string, name: string): string {
  const start = llvm.indexOf(`@${name}(`);
  const begin = llvm.lastIndexOf("\ndefine ", start) + 1;
  return llvm.slice(begin, llvm.indexOf("\n}\n", start) + 2);
}

describe("probe", () => {
  test("reads the target, the attribute groups and the ABI attributes", () => {
    const p = parseProbe(probe);
    expect(p.triple).toMatch(/linux/);
    expect(p.plainAttributes).toContain("nounwind");
    expect(p.inlineAttributes).toContain("inlinehint");
    expect(p.paramAttributes.get("bool")).toContain("zeroext");
    expect(p.paramAttributes.get("u64")).toBe("noundef");
    expect(p.returnAttributes.get("bool")).toBe("zeroext");
    expect(p.libc.get("memcmp")?.declaration).toMatch(
      /^declare i32 @memcmp\(ptr noundef, ptr noundef, i64 noundef\)$/,
    );
    expect(p.moduleMetadata.some((line) => line.includes("wchar_size"))).toBe(true);
    expect(p.pointerBytes).toBe(8);
    // -O2: lifetime markers without the size LLVM 22 dropped, and boolean
    // loads with their range.
    expect(p.lifetime).toMatchObject({ sized: false });
    expect(p.lifetime?.start).toMatch(
      /^declare void @llvm\.lifetime\.start\.p0\(ptr captures\(none\)\)$/,
    );
    expect(p.boolLoadRange).toBe(true);
  });

  test("a local's lifetime calls carry its size where the build's do", () => {
    // LLVM 21's form of the probe's lifetime markers.
    const sized = probe
      .replace(
        /@llvm\.lifetime\.(start|end)\.p0\(ptr (%\d+)\)/g,
        "@llvm.lifetime.$1.p0(i64 4, ptr $2)",
      )
      .replace(
        /@llvm\.lifetime\.(start|end)\.p0\(ptr captures\(none\)\)/g,
        "@llvm.lifetime.$1.p0(i64 immarg, ptr captures(none))",
      );
    expect(parseProbe(sized).lifetime).toMatchObject({ sized: true });
    const result = compileNativeUnit(join(fixtures, "lowering.ts"), { probe: sized });
    expect(definition(result.llvm!, "countUp")).toMatch(
      /call void @llvm\.lifetime\.start\.p0\(i64 8, ptr %\d+\)/,
    );
    expect(result.llvm).toMatch(
      /^declare void @llvm\.lifetime\.start\.p0\(i64 immarg, ptr captures\(none\)\)$/m,
    );
  });

  test("without optimization, locals have no lifetime markers", () => {
    const flags = C_FLAGS.map((f) => (f === "-O2" ? "-O0" : f));
    execFileSync("clang", [
      ...flags,
      "-S",
      "-emit-llvm",
      "-Xclang",
      "-disable-llvm-passes",
      join(dir, "probe.c"),
      "-o",
      join(dir, "probe-o0.ll"),
    ]);
    const p = parseProbe(readFileSync(join(dir, "probe-o0.ll"), "utf8"));
    expect(p.lifetime).toBe(null);
    expect(p.boolLoadRange).toBe(false);
  });
});

describe("name counter", () => {
  test("is the largest unique suffix of a global's name", () => {
    const unit = [
      '@.str = private constant [2 x i8] c"a\\00"',
      '@.str.12 = private constant [2 x i8] c"b\\00"',
      "define internal void @f.4() {",
      "  ret void",
      "}",
      "declare void @llvm.memcpy.p0.p0.i64(ptr, ptr, i64, i1 immarg)",
      "",
    ].join("\n");
    const counter = nameCounter(unit, parseProbe(probe))!;
    expect(counter.declarations).toHaveLength(11);
    expect(counter.declarations[0]).toBe("declare void @scr.native.counter()");
    expect(counter.counter.match(/^define internal void /gm)).toHaveLength(10);
    expect(nameCounter("@.str.1 = private constant i8 0\n", parseProbe(probe))).toBe(null);
  });
});

describe("lowering", () => {
  let llvm: string;
  beforeAll(() => {
    llvm = compileFixture("lowering.ts");
  });

  test("signed arithmetic carries nsw, unsigned does not", () => {
    expect(definition(llvm, "signedAdd")).toMatch(/add nsw i32/);
    expect(definition(llvm, "unsignedDivide")).toMatch(/udiv i64/);
    expect(definition(llvm, "unsignedDivide")).toMatch(/lshr i64 %\d+, 3/);
  });

  test("conversions follow C's casts", () => {
    expect(definition(llvm, "narrow")).toMatch(/trunc i64 %\d+ to i8/);
    expect(definition(llvm, "narrow")).toMatch(/^define (dso_local )?zeroext i8 @narrow/);
    expect(definition(llvm, "widen")).toMatch(/sext i32 %\d+ to i64/);
  });

  test("loops carry C11's forward-progress metadata", () => {
    expect(definition(llvm, "countUp")).toMatch(/br label %\d+, !llvm\.loop !\d+/);
    expect(llvm).toContain('!{!"llvm.loop.mustprogress"}');
  });

  test("pointer offsets by unsigned indices are inbounds nuw", () => {
    expect(definition(llvm, "byteAt")).toMatch(/getelementptr inbounds nuw i8, ptr %\d+, i64 %\d+/);
    expect(definition(llvm, "byteAt")).toMatch(/load i8, ptr %\d+, align 1/);
    expect(definition(llvm, "word")).toMatch(/load i64, ptr %\d+, align 1/);
    expect(definition(llvm, "store")).toMatch(/store i8 %\d+, ptr %\d+, align 1/);
  });

  test("booleans are i1 in values, bytes in memory and zeroext at the ABI", () => {
    const f = definition(llvm, "isSmall");
    expect(f).toMatch(/^define (dso_local )?zeroext i1 @isSmall/);
    expect(f).toMatch(/call i1 @llvm\.expect\.i1\(i1 %\d+, i1 true\)/);
    expect(f).toMatch(/phi i1 \[ false/);
    const g = definition(llvm, "isLarge");
    expect(g).toMatch(/alloca i8/);
    expect(g).toMatch(/zext i1 %\d+ to i8/);
    expect(g).toMatch(/trunc i8 %\d+ to i1/);
  });

  test("attribute wrappers select the attribute group", () => {
    const groups = new Map(
      [...llvm.matchAll(/^attributes #(\d+) = \{ (.*) \}$/gm)].map((m) => [m[1]!, m[2]!]),
    );
    const groupOf = (name: string): string =>
      groups.get(definition(llvm, name).match(/\) #(\d+)/)![1]!)!;
    expect(groupOf("hinted")).toContain("inlinehint");
    expect(groupOf("rare")).toMatch(/\bcold\b/);
    expect(groupOf("rare")).toMatch(/\bnoinline\b/);
    expect(groupOf("signedAdd")).not.toMatch(/inlinehint|noinline|cold/);
  });

  test("the module compiles with clang", () => {
    writeFileSync(join(dir, "lowering.ll"), llvm);
    execFileSync("clang", ["-O2", "-c", join(dir, "lowering.ll"), "-o", join(dir, "lowering.o")]);
  });
});

describe("structs, globals and target folding", () => {
  let llvm: string;
  let layoutAsserts: string;
  beforeAll(() => {
    const result = compileNativeUnit(join(fixtures, "structs.ts"), { probe });
    expect(result.diagnostics.map((d) => d.message)).toEqual([]);
    llvm = result.llvm!;
    layoutAsserts = result.layoutAsserts!;
  });

  test("struct interfaces are named struct types with C's layout", () => {
    expect(llvm).toContain("%struct.Node = type { ptr, i8, i64 }");
    expect(llvm).toContain("%struct.Table = type { i32, [8 x ptr], ptr }");
    expect(llvm).toContain("%struct.Hot = type { %struct.Table, i64 }");
    expect(definition(llvm, "sizeOf")).toMatch(
      /getelementptr inbounds nuw %struct\.Node, ptr %\d+, i32 0, i32 2\n.*load i64, ptr %\d+, align 8/,
    );
  });

  test("fixed arrays index by element", () => {
    expect(definition(llvm, "push")).toMatch(
      /getelementptr inbounds nuw \[8 x ptr\], ptr getelementptr inbounds nuw \(%struct\.Table, ptr @native_table, i32 0, i32 1\), i64 0, i64 %\d+/,
    );
  });

  test("declared globals are external, under their C symbol", () => {
    expect(llvm).toMatch(/^@native_table = external (dso_local )?global %struct\.Table, align 8$/m);
    expect(definition(llvm, "push")).toContain("ptr @native_table");
  });

  test("thread-locals are reached through llvm.threadlocal.address", () => {
    expect(llvm).toMatch(/^@hot = external .*thread_local.* global %struct\.Hot, align 8$/m);
    expect(definition(llvm, "threadHits")).toMatch(
      /call align 8 ptr @llvm\.threadlocal\.address\.p0\(ptr align 8 @hot\)/,
    );
  });

  test("target fields fold, and only the taken branch is lowered", () => {
    expect(definition(llvm, "branch")).toContain("call void @onMain()");
    expect(definition(llvm, "branch")).not.toContain("@onWorkers");
    expect(definition(llvm, "currentCount")).toContain("ptr @native_table");
    expect(definition(llvm, "currentCount")).not.toContain("@hot");
    expect(definition(llvm, "pointerBytes")).toContain("ret i64 8");
  });

  /** Compiles the layout asserts after C definitions with `node` as Node's
   * fields. */
  const checkLayout = (node: string): void => {
    const c = join(dir, "structs-layout.c");
    writeFileSync(
      c,
      [
        "#include <stddef.h>",
        "#include <stdint.h>",
        `typedef struct Node { ${node} } Node;`,
        "typedef struct Table { uint32_t count; Node *heads[8]; uint8_t *cursor; } Table;",
        "typedef struct Hot { Table table; size_t hits; } Hot;",
        layoutAsserts,
      ].join("\n"),
    );
    execFileSync("clang", [...C_FLAGS, "-c", c, "-o", join(dir, "structs-layout.o")], {
      stdio: "pipe",
    });
  };

  test("the layout asserts hold against the C definitions", () => {
    checkLayout("struct Node *next; uint8_t tag; size_t size;");
    expect(() => checkLayout("struct Node *next; size_t size; uint8_t tag;")).toThrow(
      /Node in structs\.ts does not match Node/,
    );
  });

  test("the module compiles with clang", () => {
    writeFileSync(join(dir, "structs.ll"), llvm);
    execFileSync("clang", ["-O2", "-c", join(dir, "structs.ll"), "-o", join(dir, "structs.o")]);
  });
});

describe("refusals", () => {
  test.each([
    ["no-directive.ts", /must start with the directive "use native"/],
    ["number-literal.ts", /bigint literals: write 1n/],
    ["mixed-widths.ts", /operands are Uint32 and Uint64; convert one explicitly/],
    ["closure.ts", /ArrowFunction is not allowed/],
    ["throw.ts", /ThrowStatement is not allowed/],
    ["loose-equality.ts", /use === or !==/],
    ["foreign-import.ts", /can import only from "@scriptc\/experimental\/native"/],
    ["target-value.ts", /compare this target field with a literal/],
    ["inline-param.ts", /Inline is not a value type/],
    ["alias-value.ts", /a top-level const is a constant, a target condition, or an alias/],
    ["array-length.ts", /a FixedArray length is a number literal/],
  ])("%s", (file, message) => {
    const result = compileNativeUnit(join(fixtures, "refused", file), { probe });
    expect(result.llvm).toBeNull();
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]!.code).toBe("SC5010");
    expect(result.diagnostics[0]!.message).toMatch(message);
  });
});

/** The define that makes a header take a module's stand-in bodies. */
const NATIVE_DEFINES: Record<string, string> = {
  "scr_key.ts": "SCR_KEY_NATIVE",
  "scr_sa.ts": "SCR_SA_NATIVE",
};

/** The object of the C unit `c` with the native modules `sources` in place
 * of the header definitions they replace, as the pack build makes it: the
 * probe and each module's stand-in header for `flags`, the unit's frontend
 * IR with the stand-ins and its use-list order, the modules merged into
 * it, and clang's name counter restored. */
function nativeObject(c: string, sources: string[], flags: string[], tag: string): Buffer {
  const frontend = ["-S", "-emit-llvm", "-Xclang", "-disable-llvm-passes"];
  const unitProbe = join(dir, `${tag}.probe.ll`);
  execFileSync("clang", [...flags, ...frontend, join(dir, "probe.c"), "-o", unitProbe]);
  const probeText = readFileSync(unitProbe, "utf8");
  const defines = sources.map((source, i) => {
    const result = compileNativeUnit(source, { probe: probeText, shapes: true });
    expect(result.diagnostics).toEqual([]);
    const shapes = join(dir, `${tag}.${i}.shapes.h`);
    writeFileSync(shapes, result.shapes!);
    return `-D${NATIVE_DEFINES[source.split("/").pop()!]}="${shapes}"`;
  });
  let ir = join(dir, `${tag}.fe.ll`);
  execFileSync("clang", [
    ...flags,
    ...defines,
    ...frontend,
    "-Xclang",
    "-emit-llvm-uselists",
    c,
    "-o",
    ir,
  ]);
  const link: string[] = [];
  sources.forEach((source, i) => {
    const merged = compileNativeUnit(source, {
      probe: probeText,
      into: readFileSync(ir, "utf8"),
      nameCounter: i === 0,
    });
    expect(merged.diagnostics).toEqual([]);
    ir = join(dir, `${tag}.merged${i}.ll`);
    writeFileSync(ir, merged.llvm!);
    if (merged.nameCounter !== null) {
      writeFileSync(join(dir, `${tag}.counter.ll`), merged.nameCounter);
      execFileSync("clang", [
        ...flags,
        "-emit-llvm",
        "-Xclang",
        "-disable-llvm-passes",
        "-c",
        join(dir, `${tag}.counter.ll`),
        "-o",
        join(dir, `${tag}.counter.bc`),
      ]);
      link.push("-Xclang", "-mlink-builtin-bitcode", "-Xclang", join(dir, `${tag}.counter.bc`));
    }
  });
  execFileSync("clang", [...flags, "-c", ir, ...link, "-o", join(dir, `${tag}.o`)]);
  return readFileSync(join(dir, `${tag}.o`));
}

/** A copy of a runtime module with one edit, next to the fixtures so that
 * its import resolves; removed with `dir`'s siblings in afterAll. */
function mutantOf(file: string, from: string, to: string): string {
  const mutantDir = mkdtempSync(join(fixtures, ".mutant-"));
  mutantDirs.push(mutantDir);
  const source = readFileSync(join(runtimeSrc, file), "utf8");
  expect(source).toContain(from);
  writeFileSync(join(mutantDir, file), source.replace(from, to));
  return join(mutantDir, file);
}
const mutantDirs: string[] = [];
afterAll(() => {
  for (const d of mutantDirs) rmSync(d, { recursive: true, force: true });
});

describe("object gate", () => {
  /* A unit that calls each scr_key function, compiled once from scr_key.h's
   * C definitions and once with the native definitions in their place. */
  const unit = [
    '#include "scr_key.h"',
    "uint64_t gate_mix(uint64_t v) { return scr_key_mix(v); }",
    "uint64_t gate_short_word(const char *b, size_t n) { return scr_key_short_word(b, n); }",
    "bool gate_equal(const char *a, const char *b, size_t n) { return scr_key_equal(a, b, n); }",
    "uint64_t gate_hash(const char *b, size_t n) { return scr_key_hash(b, n); }",
    "",
  ].join("\n");
  const ported = ["scr_key_mix", "scr_key_short_word", "scr_key_equal", "scr_key_hash"];
  const flags = [...C_FLAGS, "-I", runtimeSrc];
  let c: string;
  let cObject: Buffer;

  beforeAll(() => {
    c = join(dir, "gate.c");
    writeFileSync(c, unit);
    execFileSync("clang", [...flags, "-c", c, "-o", join(dir, "gate.c.o")]);
    cObject = readFileSync(join(dir, "gate.c.o"));
  });

  test("the stand-ins replace the ported functions' C code", () => {
    nativeObject(c, [join(runtimeSrc, "scr_key.ts")], flags, "gate.native");
    const unitIr = readFileSync(join(dir, "gate.native.fe.ll"), "utf8");
    // A stand-in returns zero, whatever the C definition computes.
    for (const name of ported) {
      const stand = unitIr.match(new RegExp(`^define internal [^@]*@${name}\\([^]*?^}$`, "m"));
      expect(stand?.[0], name).toMatch(/^ {2}ret (i64 0|i1 false)$/m);
    }
  });

  test("scr_key.ts in place of the stand-ins gives the object the C definitions give", () => {
    expect(
      nativeObject(c, [join(runtimeSrc, "scr_key.ts")], flags, "gate.native").equals(cObject),
    ).toBe(true);
  });

  test("a changed constant in scr_key.ts changes the object", () => {
    const mutant = mutantOf("scr_key.ts", "0x9e3779b97f4a7c15n", "0x9e3779b97f4a7c17n");
    expect(nativeObject(c, [mutant], flags, "gate.mutant").equals(cObject)).toBe(false);
  });
});

describe("object gate, scr_sa.ts", () => {
  /* The allocation fast paths of scr_rc.h, called with variable and
   * constant sizes, and a key hash, compiled from the headers' C
   * definitions and with scr_sa.ts and scr_key.ts in their place, for the
   * plain and the worker configuration. */
  const unit = [
    '#include "scr_runtime.h"',
    '#include "scr_key.h"',
    "void *gate_alloc(size_t n) { return scr_mem_alloc(n); }",
    "void *gate_calloc(size_t n) { return scr_mem_calloc(n); }",
    "void gate_free(void *p) { scr_mem_free(p); }",
    "void *gate_alloc24(void) { return scr_mem_alloc(24); }",
    "void *gate_calloc48(void) { return scr_mem_calloc(48); }",
    "unsigned gate_class(size_t n) { return scr_sa_class(n); }",
    "size_t gate_class_size(unsigned c) { return scr_sa_class_size(c); }",
    "void *gate_key_copy(const char *s, size_t n) { char *p = scr_mem_alloc(n + 8); if (p) *(uint64_t *)p = scr_key_hash(s, n); return p; }",
    "",
  ].join("\n");
  const modules = [join(runtimeSrc, "scr_sa.ts"), join(runtimeSrc, "scr_key.ts")];

  function cObject(flags: string[], tag: string): Buffer {
    const c = join(dir, `sa-gate-${tag}.c`);
    writeFileSync(c, unit);
    execFileSync("clang", [...flags, "-c", c, "-o", join(dir, `sa-c-${tag}.o`)]);
    return readFileSync(join(dir, `sa-c-${tag}.o`));
  }

  test.each([[[]], [["-DSCR_WORKERS"]]])("scr_sa.ts gives the C object (%j)", (extra) => {
    const flags = [...C_FLAGS, "-I", runtimeSrc, ...extra];
    const tag = extra.join("").replace(/\W/g, "") || "plain";
    const fromC = cObject(flags, tag);
    const c = join(dir, `sa-gate-${tag}.c`);
    expect(nativeObject(c, modules, flags, `sa-n-${tag}`).equals(fromC)).toBe(true);
  });

  test("the unit's lookup tables take the names they take in the C build", () => {
    // Three string literals leave clang's name counter at 2, and the second
    // lookup table of gate_tables is named after it.
    const tables = [
      '#include "scr_runtime.h"',
      'const char *gate_one(void) { return "one"; }',
      'const char *gate_two(void) { return "two"; }',
      'const char *gate_three(void) { return "three"; }',
      "long gate_tables(int x, int y) {",
      "  long a, b;",
      "  switch (x) { case 0: a = 5; break; case 1: a = 9; break; case 2: a = 17; break; case 3: a = 33; break; default: a = 0; }",
      "  switch (y) { case 0: b = 6; break; case 1: b = 10; break; case 2: b = 18; break; case 3: b = 34; break; default: b = 0; }",
      "  return a + b;",
      "}",
      "void *gate_alloc(size_t n) { return scr_mem_alloc(n); }",
      "",
    ].join("\n");
    const flags = [...C_FLAGS, "-I", runtimeSrc];
    const c = join(dir, "sa-gate-tables.c");
    writeFileSync(c, tables);
    execFileSync("clang", [...flags, "-c", c, "-o", join(dir, "sa-c-tables.o")]);
    const fromC = readFileSync(join(dir, "sa-c-tables.o"));
    expect(fromC.includes("switch.table.gate_tables.3")).toBe(true);
    expect(nativeObject(c, modules, flags, "sa-n-tables").equals(fromC)).toBe(true);
  });

  test("a changed class boundary in scr_sa.ts changes the object", () => {
    // SCR_SA_WIDE: the class of 49 to 56-byte requests.
    const mutant = mutantOf("scr_sa.ts", "const SCR_SA_WIDE = 6n;", "const SCR_SA_WIDE = 7n;");
    const flags = [...C_FLAGS, "-I", runtimeSrc];
    const fromC = cObject(flags, "mutant");
    const c = join(dir, "sa-gate-mutant.c");
    expect(nativeObject(c, [mutant, modules[1]!], flags, "sa-n-mutant").equals(fromC)).toBe(false);
  });

  test("the layout asserts compile against scr_rc.h", () => {
    const native = compileNativeUnit(join(runtimeSrc, "scr_sa.ts"), { probe });
    writeFileSync(join(dir, "sa.layout.h"), native.layoutAsserts!);
    writeFileSync(
      join(dir, "sa-layout.c"),
      `#include "scr_runtime.h"\n#include "${join(dir, "sa.layout.h")}"\n`,
    );
    execFileSync("clang", [
      ...C_FLAGS,
      "-I",
      runtimeSrc,
      "-c",
      join(dir, "sa-layout.c"),
      "-o",
      join(dir, "sa-layout.o"),
    ]);
  });
});

describe("frontend shape", () => {
  /** The functions of a module's text, by name, with attribute group
   * numbers, block comments, linkage and struct type prefixes left out. */
  function functions(llvm: string): Map<string, string> {
    const out = new Map<string, string>();
    for (const m of llvm.matchAll(/^define [^@]*@(\w+)\([^]*?^}$/gm))
      out.set(
        m[1]!,
        m[0]
          .replace(/^define (internal |dso_local |hidden )*/, "define ")
          .replace(/#\d+/g, "#G")
          .replace(/ *;.*$/gm, "")
          .replace(/%native\./g, "%struct.")
          .replace(/!llvm\.loop !\d+/g, "!llvm.loop !L")
          .replace(/!(range|noundef) !\d+/g, "!$1 !N")
          .replace(/\n\n/g, "\n"),
      );
    return out;
  }

  test("scr_key.ts has the IR clang's frontend gives scr_key.h at -O0", () => {
    const flags = C_FLAGS.map((f) => (f === "-O2" ? "-O0" : f));
    const frontend = ["-S", "-emit-llvm", "-Xclang", "-disable-llvm-passes"];
    execFileSync("clang", [...flags, ...frontend, join(dir, "probe.c"), "-o", join(dir, "o0.ll")]);
    const native = compileNativeUnit(join(runtimeSrc, "scr_key.ts"), {
      probe: readFileSync(join(dir, "o0.ll"), "utf8"),
    });
    expect(native.diagnostics).toEqual([]);
    const c = join(dir, "o0-unit.c");
    writeFileSync(
      c,
      '#include "scr_key.h"\nuint64_t (*use)(const char *, size_t) = scr_key_hash;\nbool (*use_equal)(const char *, const char *, size_t) = scr_key_equal;\n',
    );
    execFileSync("clang", [...flags, "-I", runtimeSrc, ...frontend, c, "-o", join(dir, "o0-c.ll")]);
    const fromC = functions(readFileSync(join(dir, "o0-c.ll"), "utf8"));
    const fromNative = functions(native.llvm!);
    expect([...fromNative.keys()].sort()).toEqual([...fromC.keys()].sort());
    for (const [name, body] of fromNative) expect(body, name).toBe(fromC.get(name));
  });

  test.each([[[]], [["-DSCR_WORKERS"]]])(
    "scr_key.ts and scr_sa.ts have the IR clang's frontend gives their headers at -O2 (%j)",
    (extra) => {
      const flags = [...C_FLAGS, ...extra];
      const tag = extra.join("").replace(/\W/g, "") || "plain";
      const frontend = ["-S", "-emit-llvm", "-Xclang", "-disable-llvm-passes"];
      const probeFile = join(dir, `o2-${tag}.probe.ll`);
      execFileSync("clang", [...flags, ...frontend, join(dir, "probe.c"), "-o", probeFile]);
      const c = join(dir, `o2-${tag}.c`);
      writeFileSync(
        c,
        [
          '#include "scr_runtime.h"',
          '#include "scr_key.h"',
          "void *(*use_alloc)(size_t) = scr_mem_alloc;",
          "void *(*use_calloc)(size_t) = scr_mem_calloc;",
          "void (*use_free)(void *) = scr_mem_free;",
          "uint64_t (*use_hash)(const char *, size_t) = scr_key_hash;",
          "bool (*use_equal)(const char *, const char *, size_t) = scr_key_equal;",
          "",
        ].join("\n"),
      );
      execFileSync("clang", [
        ...flags,
        "-I",
        runtimeSrc,
        ...frontend,
        c,
        "-o",
        join(dir, `o2-${tag}.ll`),
      ]);
      const fromC = functions(readFileSync(join(dir, `o2-${tag}.ll`), "utf8"));
      for (const file of ["scr_key.ts", "scr_sa.ts"]) {
        const native = compileNativeUnit(join(runtimeSrc, file), {
          probe: readFileSync(probeFile, "utf8"),
        });
        expect(native.diagnostics).toEqual([]);
        for (const [name, body] of functions(native.llvm!)) {
          // C declares scr_key_short_word's `first` and `last` before it
          // loads either, which a binding with an initializer can't say:
          // the lifetime of `last` starts one call later. The object gate
          // covers the function.
          if (name === "scr_key_short_word") continue;
          expect(fromC.has(name), name).toBe(true);
          expect(body, name).toBe(fromC.get(name));
        }
      }
    },
  );
});

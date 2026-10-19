/* The probe: what clang's frontend emits for a runtime unit's exact flags,
 * so that a native module's IR matches the C runtime's. The pack build
 * compiles `nativeProbeSource()` the way it compiles a C unit, stopping
 * before LLVM passes (`-S -emit-llvm -Xclang -disable-llvm-passes`), and
 * hands the result to `scriptc native-unit --probe`. `parseProbe` reads
 * from it:
 *
 * - the data layout, triple and module flags (not the ident: linking
 *   appends a linked module's `!llvm.ident` to the unit's);
 * - the function attribute group of an ordinary definition, and of a
 *   `static inline` one, and what follows the group in `define` (`align 64`
 *   under -falign-functions=64);
 * - the linkage prefix clang gives external definitions (`dso_local` or
 *   nothing);
 * - the ABI attributes clang puts on parameters and returns of each scalar
 *   type (`noundef`, `zeroext`, `signext`), which differ between targets;
 * - the declaration and call-site attributes of each libc function a
 *   native module may call, which come from the target's own headers;
 * - the build configuration (`target` in a native module): the runtime's
 *   defines and the sanitizer, as the unit is compiled with them;
 * - the TLS model of an external thread-local (`-ftls-model`);
 * - whether locals get lifetime markers and boolean loads a range, as in
 *   optimizing builds. */

/** libc functions a native module can call, with the probe call that shows
 * clang's declaration. */
const PROBE_LIBC: Record<string, string> = {
  memcmp:
    "int scr_native_probe_memcmp(const void *a, const void *b, size_t n) { return memcmp(a, b, n); }",
  malloc: "void *scr_native_probe_malloc(size_t n) { return malloc(n); }",
  calloc: "void *scr_native_probe_calloc(size_t c, size_t n) { return calloc(c, n); }",
  free: "void scr_native_probe_free(void *p) { free(p); }",
};

/** The build configuration a native module sees as `target`, read from the
 * defines and predefined macros the C unit is compiled with. */
const PROBE_CONFIG: readonly (readonly [string, string])[] = [
  ["workers", "defined(SCR_WORKERS)"],
  ["library", "defined(SCR_LIB)"],
  ["threadInstances", "defined(SCR_THREAD_INSTANCES)"],
  ["rcAudit", "defined(SCR_RC_AUDIT)"],
  ["sanitized", "defined(__SANITIZE_ADDRESS__) || SCR_NATIVE_PROBE_ASAN"],
];

export type NativeTargetConfig = Readonly<Record<string, boolean>>;

/** Scalar C types in the ABI probe, keyed by signedness and width. */
const PROBE_SCALARS: readonly (readonly [string, string])[] = [
  ["bool", "_Bool"],
  ["s8", "int8_t"],
  ["u8", "uint8_t"],
  ["s16", "int16_t"],
  ["u16", "uint16_t"],
  ["s32", "int32_t"],
  ["u32", "uint32_t"],
  ["s64", "int64_t"],
  ["u64", "uint64_t"],
  ["ptr", "void *"],
];

export function nativeProbeSource(): string {
  const lines = [
    "/* scriptc native-unit probe: compiled with a runtime unit's flags. */",
    "#include <stdbool.h>",
    "#include <stddef.h>",
    "#include <stdint.h>",
    "#include <stdlib.h>",
    "#include <string.h>",
    "#if defined(__has_feature)",
    "#if __has_feature(address_sanitizer)",
    "#define SCR_NATIVE_PROBE_ASAN 1",
    "#endif",
    "#endif",
    "#ifndef SCR_NATIVE_PROBE_ASAN",
    "#define SCR_NATIVE_PROBE_ASAN 0",
    "#endif",
    ...PROBE_CONFIG.flatMap(([key, test]) => [
      `#if ${test}`,
      `int scr_native_probe_config_${key} = 1;`,
      "#else",
      `int scr_native_probe_config_${key} = 0;`,
      "#endif",
    ]),
    "extern _Thread_local int scr_native_probe_tls_value;",
    "int scr_native_probe_tls(void) { return scr_native_probe_tls_value; }",
    "extern int scr_native_probe_global_value;",
    "int scr_native_probe_global(void) { return scr_native_probe_global_value; }",
    "void scr_native_probe_plain(void) {}",
    "void scr_native_probe_scope(void) { int local = 0; (void)local; }",
    "_Bool scr_native_probe_load_bool(_Bool *p) { return *p; }",
    "static inline void scr_native_probe_inline(void) {}",
    "void scr_native_probe_use_inline(void) { scr_native_probe_inline(); }",
  ];
  for (const [key, c] of PROBE_SCALARS) {
    lines.push(`void scr_native_probe_arg_${key}(${c} value) { (void)value; }`);
    lines.push(`${c} scr_native_probe_ret_${key}(void) { return 0; }`);
  }
  for (const source of Object.values(PROBE_LIBC)) lines.push(source);
  return lines.join("\n") + "\n";
}

export interface NativeLibcBinding {
  /** The `declare` line, without its attribute group. */
  declaration: string;
  /** The attribute group text of the declaration. */
  declarationAttributes: string;
  /** The attribute group text of the call site, or null when clang puts none. */
  callAttributes: string | null;
}

export interface NativeProbe {
  dataLayout: string;
  triple: string;
  /** The attribute group text of an ordinary external definition. */
  plainAttributes: string;
  /** The attribute group text of a `static inline` definition. */
  inlineAttributes: string;
  /** What precedes the return type in `define` for an external definition. */
  definitionPrefix: string;
  /** What follows the attribute group in `define`, such as ` align 64`. */
  definitionSuffix: string;
  /** Parameter attributes per scalar key (see PROBE_SCALARS), without the type. */
  paramAttributes: ReadonlyMap<string, string>;
  /** Return attributes per scalar key. */
  returnAttributes: ReadonlyMap<string, string>;
  libc: ReadonlyMap<string, NativeLibcBinding>;
  /** `!llvm.module.flags` and the nodes it names, as lines with numbers
   * starting at 0. */
  moduleMetadata: string[];
  pointerBytes: number;
  /** The build configuration (PROBE_CONFIG). */
  config: NativeTargetConfig;
  /** What comes between `external` and `global` in the declaration of an
   * external global (`dso_local` or nothing). */
  externalGlobalPrefix: string;
  /** The same for an external thread-local, such as
   * `thread_local(initialexec)`. */
  externalThreadLocalPrefix: string;
  /** The declarations of the lifetime intrinsics, without attribute
   * groups, the attribute group text of their calls, and whether a call
   * gives the local's size first (LLVM 21 and before); null when the build
   * marks no lifetimes. */
  lifetime: { start: string; end: string; callAttributes: string | null; sized: boolean } | null;
  /** Whether a boolean load carries `!range` and `!noundef`. */
  boolLoadRange: boolean;
}

export class NativeProbeError extends Error {}

function attributeGroups(text: string): Map<string, string> {
  const groups = new Map<string, string>();
  for (const match of text.matchAll(/^attributes #(\d+) = \{ (.*) \}$/gm))
    groups.set(match[1]!, match[2]!);
  return groups;
}

/** A probe definition: [line, prefix before the name, parameters, attribute
 * group id, what follows the group]. */
function definitionOf(text: string, name: string): RegExpMatchArray {
  const pattern = new RegExp(`^define ([^@]*?)@${name}\\(([^)]*)\\)[^#]*#(\\d+)(.*) \\{$`, "m");
  const match = text.match(pattern);
  if (match === null) throw new NativeProbeError(`the probe has no definition of ${name}`);
  return match;
}

/** The body of a probe definition. */
function bodyOf(text: string, name: string): string {
  const start = text.indexOf(definitionOf(text, name)[0]);
  return text.slice(start, text.indexOf("\n}\n", start));
}

/** The attributes between the linkage and the return type of `define`. */
function returnAttributesOf(prefix: string, linkage: string): string {
  const rest = prefix.slice(linkage.length).trim().split(/\s+/);
  rest.pop(); // the type
  return rest.join(" ");
}

export function parseProbe(text: string): NativeProbe {
  const dataLayout = text.match(/^target datalayout = "(.*)"$/m)?.[1];
  const triple = text.match(/^target triple = "(.*)"$/m)?.[1];
  if (dataLayout === undefined || triple === undefined)
    throw new NativeProbeError("the probe has no target datalayout or triple");
  const groups = attributeGroups(text);
  const group = (id: string): string => {
    const g = groups.get(id);
    if (g === undefined) throw new NativeProbeError(`the probe has no attribute group #${id}`);
    return g;
  };
  const plain = definitionOf(text, "scr_native_probe_plain");
  const inline = definitionOf(text, "scr_native_probe_inline");
  const definitionPrefix = plain[1]!.trim().replace(/\s*void$/, "");
  const paramAttributes = new Map<string, string>();
  const returnAttributes = new Map<string, string>();
  for (const [key] of PROBE_SCALARS) {
    const arg = definitionOf(text, `scr_native_probe_arg_${key}`);
    const param = arg[2]!.trim().split(/\s+/);
    param.shift(); // the type
    param.pop(); // the value name
    paramAttributes.set(key, param.join(" "));
    const ret = definitionOf(text, `scr_native_probe_ret_${key}`);
    returnAttributes.set(key, returnAttributesOf(ret[1]!.trim(), definitionPrefix));
  }
  const libc = new Map<string, NativeLibcBinding>();
  for (const name of Object.keys(PROBE_LIBC)) {
    const decl = text.match(new RegExp(`^declare (.*@${name}\\(.*\\)) #(\\d+)$`, "m"));
    if (decl === null) throw new NativeProbeError(`the probe has no declaration of ${name}`);
    const call = text.match(new RegExp(`call [^@]*@${name}\\([^)]*\\)(?: #(\\d+))?$`, "m"));
    libc.set(name, {
      declaration: `declare ${decl[1]}`,
      declarationAttributes: group(decl[2]!),
      callAttributes: call?.[1] === undefined ? null : group(call[1]),
    });
  }
  const config: Record<string, boolean> = {};
  for (const [key] of PROBE_CONFIG) {
    const m = text.match(new RegExp(`^@scr_native_probe_config_${key} = .*global i32 (\\d+)`, "m"));
    if (m === null) throw new NativeProbeError(`the probe has no configuration value ${key}`);
    config[key] = m[1] !== "0";
  }
  const externalPrefix = (name: string): string => {
    const m = text.match(new RegExp(`^@${name} = external (.*?) ?global `, "m"));
    if (m === null) throw new NativeProbeError(`the probe has no declaration of ${name}`);
    return m[1]!;
  };
  const pointerBits = dataLayout.match(/(?:^|-)p(?::(\d+))?:(\d+)/);
  let lifetime: NativeProbe["lifetime"] = null;
  const start = bodyOf(text, "scr_native_probe_scope").match(
    /call void @llvm\.lifetime\.start\.p0\((i64 \d+, )?ptr %\w+\)(?: #(\d+))?$/m,
  );
  if (start !== null) {
    const declaration = (which: string): string => {
      const m = text.match(
        new RegExp(`^(declare void @llvm\\.lifetime\\.${which}\\.p0\\(.*\\))(?: #\\d+)?$`, "m"),
      );
      if (m === null)
        throw new NativeProbeError(`the probe has no declaration of llvm.lifetime.${which}`);
      return m[1]!;
    };
    lifetime = {
      start: declaration("start"),
      end: declaration("end"),
      callAttributes: start[2] === undefined ? null : group(start[2]),
      sized: start[1] !== undefined,
    };
  }
  const boolLoad = bodyOf(text, "scr_native_probe_load_bool").match(
    /= load i8, ptr %\w+, align 1(.*)$/m,
  );
  if (boolLoad === null) throw new NativeProbeError("the probe has no boolean load");
  return {
    dataLayout,
    triple,
    plainAttributes: group(plain[3]!),
    inlineAttributes: group(inline[3]!),
    definitionPrefix,
    definitionSuffix: plain[4]!,
    paramAttributes,
    returnAttributes,
    libc,
    moduleMetadata: moduleMetadata(text),
    pointerBytes: pointerBits === null ? 8 : Number(pointerBits[2]) / 8,
    config,
    externalGlobalPrefix: externalPrefix("scr_native_probe_global_value"),
    externalThreadLocalPrefix: externalPrefix("scr_native_probe_tls_value"),
    lifetime,
    boolLoadRange: /!range/.test(boolLoad[1]!),
  };
}

/** `!llvm.module.flags` with the nodes it names, renumbered from 0. */
function moduleMetadata(text: string): string[] {
  const nodes = new Map<string, string>();
  for (const match of text.matchAll(/^!(\d+) = (.*)$/gm)) nodes.set(match[1]!, match[2]!);
  const renumber = new Map<string, number>();
  const named: string[] = [];
  for (const name of ["llvm.module.flags"]) {
    const line = text.match(new RegExp(`^!${name.replace(".", "\\.")} = !\\{(.*)\\}$`, "m"));
    if (line === null) continue;
    const refs = [...line[1]!.matchAll(/!(\d+)/g)].map((m) => m[1]!);
    for (const ref of refs) if (!renumber.has(ref)) renumber.set(ref, renumber.size);
    named.push(`!${name} = !{${refs.map((r) => `!${renumber.get(r)}`).join(", ")}}`);
  }
  const out = [...named, ""];
  for (const [old, index] of renumber) {
    const body = nodes.get(old);
    if (body === undefined) throw new NativeProbeError(`the probe has no metadata node !${old}`);
    if (/!\d/.test(body))
      throw new NativeProbeError(`module metadata node !${old} refers to other nodes`);
    out.push(`!${index} = ${body}`);
  }
  return out;
}

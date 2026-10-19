/* The typed IR of a native module (`"use native";`): what the lowering
 * (lower.ts) produces from the TypeScript source and the emitter (emit.ts)
 * turns into LLVM text. Every expression carries its native type. The IR
 * has no reference counts, exceptions, boxing or allocation: a native module
 * can only express what this file describes. */

/** A C struct layout: an interface of a native module. */
export interface NativeStruct {
  name: string;
  /** The C struct this interface mirrors (`extends CStruct<"Name">`), if any. */
  cName: string | null;
  fields: NativeField[];
  size: number;
  align: number;
}

export interface NativeField {
  name: string;
  type: NativeMemType;
  offset: number;
}

/** A native value type. Pointers are untyped at the LLVM level; `to` is the
 * pointee, null for `void *` and function pointers. A struct reference is a
 * pointer to a struct's storage; an array reference is the address of an
 * array embedded in a struct, which is not a value of its own. */
export type NativeType =
  | { kind: "int"; bits: 8 | 16 | 32 | 64; signed: boolean; name: string }
  | { kind: "bool" }
  | { kind: "ptr"; to: NativeType | null }
  | { kind: "ref"; def: NativeStruct }
  | { kind: "arrayref"; element: NativeMemType; length: number }
  | { kind: "void" };

/** A type as stored in memory: a value type, an embedded struct, or an
 * embedded array. */
export type NativeMemType =
  | NativeType
  | { kind: "inline"; def: NativeStruct }
  | { kind: "array"; element: NativeMemType; length: number };

export const BOOL: NativeType = { kind: "bool" };
export const VOID: NativeType = { kind: "void" };
export const RAW_POINTER: NativeType = { kind: "ptr", to: null };

export type NativeBinaryOp =
  | "add"
  | "sub"
  | "mul"
  | "div"
  | "rem"
  | "and"
  | "or"
  | "xor"
  | "shl"
  | "shr"
  | "eq"
  | "ne"
  | "lt"
  | "le"
  | "gt"
  | "ge";

export type NativeExpr =
  | { kind: "const"; type: NativeType; value: bigint }
  | { kind: "null"; type: NativeType }
  /** A read of a local or parameter slot. */
  | { kind: "local"; type: NativeType; slot: number }
  /** The address of a global, through `llvm.threadlocal.address` for a thread-local. */
  | { kind: "global"; type: NativeType; name: string; threadLocal: boolean; align: number }
  | { kind: "binary"; type: NativeType; op: NativeBinaryOp; left: NativeExpr; right: NativeExpr }
  | { kind: "not"; type: NativeType; operand: NativeExpr }
  | { kind: "complement"; type: NativeType; operand: NativeExpr }
  | { kind: "negate"; type: NativeType; operand: NativeExpr }
  | { kind: "logical"; type: NativeType; op: "and" | "or"; left: NativeExpr; right: NativeExpr }
  | {
      kind: "conditional";
      type: NativeType;
      condition: NativeExpr;
      whenTrue: NativeExpr;
      whenFalse: NativeExpr;
    }
  | { kind: "convert"; type: NativeType; operand: NativeExpr }
  | { kind: "ptrToInt"; type: NativeType; operand: NativeExpr }
  | { kind: "intToPtr"; type: NativeType; operand: NativeExpr }
  /** `p + index` in elements of `element`; `nuw` when the index is unsigned. */
  | {
      kind: "offset";
      type: NativeType;
      pointer: NativeExpr;
      index: NativeExpr;
      element: NativeMemType;
    }
  /** `&base->field`. */
  | { kind: "fieldAddress"; type: NativeType; base: NativeExpr; def: NativeStruct; index: number }
  /** `&base[index]` for an embedded array. */
  | {
      kind: "elementAddress";
      type: NativeType;
      base: NativeExpr;
      element: NativeMemType;
      length: number;
      index: NativeExpr;
    }
  /** `left - right` in elements of `elementSize` bytes. */
  | { kind: "diff"; type: NativeType; left: NativeExpr; right: NativeExpr; elementSize: number }
  /** `unaligned` marks a loadUnaligned. */
  | { kind: "load"; type: NativeType; pointer: NativeExpr; align: number; unaligned?: boolean }
  | { kind: "call"; type: NativeType; callee: string; args: NativeExpr[] }
  | { kind: "expect"; type: NativeType; operand: NativeExpr; expected: boolean }
  /** An assignment used as a value: stores `value` into `slot` and yields
   * it. With `op`, a compound assignment: `slot = slot op value`, with
   * `value` evaluated first, as clang does. */
  | { kind: "assign"; type: NativeType; slot: number; value: NativeExpr; op?: NativeBinaryOp }
  /** `++`/`--` on a local: yields the old value when `postfix`. */
  | { kind: "step"; type: NativeType; slot: number; delta: 1n | -1n; postfix: boolean };

export type NativeStmt =
  | { kind: "expr"; expr: NativeExpr }
  /** `*pointer = value`, or `*pointer = *pointer op value` with `op`; the
   * value is evaluated before the pointer, as clang does. */
  | { kind: "store"; pointer: NativeExpr; value: NativeExpr; align: number; op?: NativeBinaryOp }
  | { kind: "memset"; pointer: NativeExpr; byte: NativeExpr; size: NativeExpr; align: number }
  /** A local initialized by loadUnaligned: C's `memcpy(&local, source,
   * sizeof local)`. */
  | { kind: "copyToLocal"; slot: number; source: NativeExpr; size: number }
  /** A local's declaration: where its lifetime starts. Its initializer
   * follows as an assignment. */
  | { kind: "declare"; slot: number }
  /** A block: the locals declared in it end with it, as in a C compound
   * statement. */
  | { kind: "scope"; body: NativeStmt[] }
  | { kind: "if"; condition: NativeExpr; consequent: NativeStmt[]; alternative: NativeStmt[] }
  /** `while`, `do`/`while` and `for` loops: a `for` loop's `init` is in a
   * scope of its own, and `update` runs after the body and after
   * `continue`. A null condition is a `for` loop without one, or a `while`
   * or `do` loop on `true`. `mustProgress` is C11's assumption for loops
   * whose condition is not a constant expression. */
  | {
      kind: "loop";
      form: "while" | "do" | "for";
      init: NativeStmt[];
      condition: NativeExpr | null;
      body: NativeStmt[];
      update: NativeStmt[];
      mustProgress: boolean;
    }
  | { kind: "break" }
  | { kind: "continue" }
  | { kind: "return"; value: NativeExpr | null };

export interface NativeSlot {
  name: string;
  type: NativeType;
}

export type NativeAttribute = "inline" | "alwaysInline" | "noinline" | "cold";

export interface NativeFunction {
  name: string;
  exported: boolean;
  attributes: NativeAttribute[];
  params: NativeSlot[];
  returnType: NativeType;
  /** Parameters first (slots 0..params.length-1), then locals. */
  slots: NativeSlot[];
  body: NativeStmt[];
}

/** A function the module calls but does not define. `builtin` names a libc
 * function whose declaration and call-site attributes come from the probe. */
export interface NativeExtern {
  name: string;
  params: NativeType[];
  returnType: NativeType;
  builtin: boolean;
}

/** A global the module refers to but does not define. */
export interface NativeGlobal {
  symbol: string;
  type: NativeMemType;
  threadLocal: boolean;
  align: number;
}

export interface NativeModule {
  file: string;
  structs: NativeStruct[];
  functions: NativeFunction[];
  externs: NativeExtern[];
  globals: NativeGlobal[];
}

export function sameType(a: NativeType, b: NativeType): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "int" && b.kind === "int") return a.bits === b.bits && a.signed === b.signed;
  if (a.kind === "ref" && b.kind === "ref") return a.def === b.def;
  return true;
}

export function typeName(t: NativeMemType): string {
  switch (t.kind) {
    case "int":
      return t.name;
    case "bool":
      return "boolean";
    case "void":
      return "void";
    case "ptr":
      return t.to === null ? "RawPointer" : `Pointer<${typeName(t.to)}>`;
    case "ref":
      return t.def.name;
    case "arrayref":
    case "array":
      return `FixedArray<${typeName(t.element)}, ${t.length}>`;
    case "inline":
      return `Inline<${t.def.name}>`;
  }
}

/** Size in bytes, for a pointer width of `pointerBytes`. */
export function sizeOfType(t: NativeMemType, pointerBytes: number): number {
  switch (t.kind) {
    case "int":
      return t.bits / 8;
    case "bool":
      return 1;
    case "ptr":
    case "ref":
    case "arrayref":
      return pointerBytes;
    case "void":
      return 1;
    case "inline":
      return t.def.size;
    case "array":
      return sizeOfType(t.element, pointerBytes) * t.length;
  }
}

/** Natural alignment in bytes, as C lays the type out. */
export function alignOfType(t: NativeMemType, pointerBytes: number): number {
  switch (t.kind) {
    case "inline":
      return t.def.align;
    case "array":
      return alignOfType(t.element, pointerBytes);
    default:
      return sizeOfType(t, pointerBytes);
  }
}

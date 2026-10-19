/**
 * Native modules: the low-level subset scriptc compiles with no runtime
 * underneath (`scriptc native-unit`). A native module starts with the
 * directive `"use native";`. It runs only as compiled native code, never
 * under Node.js, so this entry point has declarations and no implementation.
 *
 * Integers are `bigint` values with a declared width. scriptc gives each
 * width C's semantics: unsigned arithmetic wraps, signed overflow is
 * undefined, `/` truncates, and widths never convert implicitly; the
 * conversion functions below are the casts.
 */

export type Int8 = bigint;
export type Uint8 = bigint;
export type Int16 = bigint;
export type Uint16 = bigint;
export type Int32 = bigint;
export type Uint32 = bigint;
export type Int64 = bigint;
export type Uint64 = bigint;
/** `size_t`. */
export type Size = bigint;
/** `intptr_t` and `ptrdiff_t`. */
export type Intptr = bigint;
/** `uintptr_t`. */
export type Uintptr = bigint;
/** C `int`, for libc signatures. */
export type CInt = bigint;
/** C `long`: 64-bit on LP64 targets, 32-bit on Windows. */
export type CLong = bigint;
export type Float32 = number;
export type Float64 = number;

type Convertible = bigint | number | boolean;
/** Converts to `Int8`, as the C cast `(int8_t)value` does. */
export declare function Int8(value: Convertible): Int8;
/** Converts to `Uint8`, as the C cast `(uint8_t)value` does. */
export declare function Uint8(value: Convertible): Uint8;
/** Converts to `Int16`, as the C cast `(int16_t)value` does. */
export declare function Int16(value: Convertible): Int16;
/** Converts to `Uint16`, as the C cast `(uint16_t)value` does. */
export declare function Uint16(value: Convertible): Uint16;
/** Converts to `Int32`, as the C cast `(int32_t)value` does. */
export declare function Int32(value: Convertible): Int32;
/** Converts to `Uint32`, as the C cast `(uint32_t)value` does. */
export declare function Uint32(value: Convertible): Uint32;
/** Converts to `Int64`, as the C cast `(int64_t)value` does. */
export declare function Int64(value: Convertible): Int64;
/** Converts to `Uint64`, as the C cast `(uint64_t)value` does. */
export declare function Uint64(value: Convertible): Uint64;
/** Converts to `Size`, as the C cast `(size_t)value` does. */
export declare function Size(value: Convertible): Size;
/** Converts to `Intptr`, as the C cast `(intptr_t)value` does. */
export declare function Intptr(value: Convertible): Intptr;
/** Converts to `Uintptr`, as the C cast `(uintptr_t)value` does. */
export declare function Uintptr(value: Convertible): Uintptr;
/** Converts to `CInt`, as the C cast `(int)value` does. */
export declare function CInt(value: Convertible): CInt;
/** Converts to `CLong`, as the C cast `(long)value` does. */
export declare function CLong(value: Convertible): CLong;
/** Converts to `Float32`, as the C cast `(float)value` does. */
export declare function Float32(value: Convertible): Float32;
/** Converts to `Float64`, as the C cast `(double)value` does. */
export declare function Float64(value: Convertible): Float64;

declare const rawPointer: unique symbol;
/** `void *`. Every pointer converts to it. */
export interface RawPointer {
  readonly [rawPointer]: true;
}
/** `T *`. A pointer may be null, as in C. */
export interface Pointer<T> extends RawPointer {
  /** `*p`. */
  get(): T;
  /** `*p = value`. */
  set(value: T): void;
  /** `p + index`, in elements. */
  at(index: bigint): Pointer<T>;
  /** `p - from`, in elements. */
  diff(from: Pointer<T>): Intptr;
  /** `p == NULL`. */
  isNull(): boolean;
}
/** `(T *)p`. */
export declare function cast<T>(p: RawPointer | null): Pointer<T>;
/** `&storage`. */
export declare function addressOf<S>(storage: S): Pointer<S>;
/** `&s->field`. */
export declare function fieldAddress<S, K extends keyof S>(s: S, field: K): Pointer<S[K]>;
/** `(char *)p + bytes`. */
export declare function byteOffset(p: RawPointer, bytes: bigint): RawPointer;
/** `(uintptr_t)p`. */
export declare function toAddress(p: RawPointer | null): Uintptr;
/** `(T *)address`. */
export declare function fromAddress<T>(address: Uintptr): Pointer<T>;
/** `(T *)NULL`. */
export declare function nullPointer<T>(): Pointer<T>;
/** A load from a pointer of any alignment: `memcpy(&value, p, sizeof value)`. */
export declare function loadUnaligned<T extends bigint | number>(p: RawPointer): T;
/** A store to a pointer of any alignment: `memcpy(p, &value, sizeof value)`. */
export declare function storeUnaligned<T extends bigint | number>(p: RawPointer, value: T): void;

/** `T field[N]` inside a struct. */
export interface FixedArray<T, N extends number> {
  readonly length: N;
  get(index: bigint): T;
  set(index: bigint, value: T): void;
  at(index: bigint): Pointer<T>;
}
/** A struct embedded by value; reading the field gives a reference to it. */
export type Inline<S> = S;
/** An anonymous union of the members of `S`. */
export type Overlay<S> = S;
/** An integer bitfield of `N` bits. */
export type Bits<T extends bigint, N extends number> = T;
/** `_Alignas(N) T`. */
export type Aligned<T, N extends number> = T;
/** A field that exists only in the named build configuration. */
export type When<Flag extends string, T> = T;
/** `_Thread_local` storage, for `declare const`. */
export type ThreadLocal<S> = S;
/** A declaration whose C symbol is `Symbol` rather than its TypeScript name. */
export type Extern<T, Symbol extends string> = T;
declare const cstruct: unique symbol;
/** Marks an interface as the twin of the C struct `Name`, for layout checks. */
export interface CStruct<Name extends string> {
  readonly [cstruct]?: Name;
}

/** `sizeof(T)`. */
export declare function sizeOf<T>(): Size;
/** `_Alignof(T)`. */
export declare function alignOf<T>(): Size;
/** `offsetof(S, field)`. */
export declare function offsetOf<S>(field: keyof S): Size;
/** A global defined by this module, zero-initialized unless `init` is given. */
export declare function global<T>(init?: T): Pointer<T>;
/** A `_Thread_local` defined by this module, zero-initialized. */
export declare function threadLocal<T>(init?: T): T;
/** A `static const` table. */
export declare function constant<T>(init: unknown): T;

/** `inline`: `inlinehint` on the function. */
export declare function inline<F extends Function>(f: F): F;
/** `__attribute__((always_inline))`. */
export declare function alwaysInline<F extends Function>(f: F): F;
/** `__attribute__((noinline))`. */
export declare function noinline<F extends Function>(f: F): F;
/** `__attribute__((cold))`. */
export declare function cold<F extends Function>(f: F): F;
/** `__builtin_expect(condition, 1)`. */
export declare function likely(condition: boolean): boolean;
/** `__builtin_expect(condition, 0)`. */
export declare function unlikely(condition: boolean): boolean;
/** `__builtin_expect(value, expected)`. */
export declare function expect<T extends bigint>(value: T, expected: T): T;

/** libc `memset`, emitted as `llvm.memset`. */
export declare function memset(p: RawPointer, byte: CInt, n: Size): RawPointer;
/** libc `memcpy`, emitted as `llvm.memcpy`. */
export declare function memcpy(destination: RawPointer, source: RawPointer, n: Size): RawPointer;
/** libc `memmove`, emitted as `llvm.memmove`. */
export declare function memmove(destination: RawPointer, source: RawPointer, n: Size): RawPointer;
/** libc `memcmp`, declared as the target's `<string.h>` declares it. */
export declare function memcmp(a: RawPointer, b: RawPointer, n: Size): CInt;
/** libc `malloc`, declared as the target's `<stdlib.h>` declares it. */
export declare function malloc(n: Size): RawPointer | null;
/** libc `calloc`, declared as the target's `<stdlib.h>` declares it. */
export declare function calloc(count: Size, n: Size): RawPointer | null;
/** libc `free`, declared as the target's `<stdlib.h>` declares it. */
export declare function free(p: RawPointer | null): void;
/** A string literal as a private constant: `"text"`. */
export declare function cstring(text: string): Pointer<Uint8>;

export type MemoryOrder = "relaxed" | "acquire" | "release" | "acq_rel" | "seq_cst";
/** `atomic_load_explicit`. */
export declare function atomicLoad<T>(p: Pointer<T>, order: MemoryOrder): T;
/** `atomic_store_explicit`. */
export declare function atomicStore<T>(p: Pointer<T>, value: T, order: MemoryOrder): void;
/** `atomic_exchange_explicit`. */
export declare function atomicExchange<T>(p: Pointer<T>, value: T, order: MemoryOrder): T;
/** `atomic_compare_exchange_{weak,strong}_explicit`. */
export declare function atomicCompareExchange<T>(
  p: Pointer<T>,
  expected: Pointer<T>,
  desired: T,
  weak: boolean,
  success: MemoryOrder,
  failure: MemoryOrder,
): boolean;
/** `atomic_fetch_add_explicit`. */
export declare function atomicFetchAdd<T extends bigint>(
  p: Pointer<T>,
  value: T,
  order: MemoryOrder,
): T;
/** `atomic_fetch_sub_explicit`. */
export declare function atomicFetchSub<T extends bigint>(
  p: Pointer<T>,
  value: T,
  order: MemoryOrder,
): T;
/** `atomic_thread_fence`. */
export declare function fence(order: MemoryOrder): void;

/** The configuration the unit is built for. Conditions on these fields fold at compile time. */
export declare const target: {
  readonly workers: boolean;
  readonly library: boolean;
  readonly threadInstances: boolean;
  /** -DSCR_RC_AUDIT. */
  readonly rcAudit: boolean;
  /** AddressSanitizer. */
  readonly sanitized: boolean;
  readonly os: "linux" | "darwin" | "windows" | "wasi";
  readonly arch: "x64" | "arm64" | "wasm32";
  readonly pointerBytes: 4n | 8n;
};

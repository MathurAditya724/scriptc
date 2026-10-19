"use native";
/* The small-object allocator's fast paths (scr_rc.h, scr_alloc.c), in the
 * native subset of TypeScript. With SCR_SA_NATIVE defined, scr_rc.h
 * defines these functions with stand-in bodies, and the pack build puts
 * this module's code in their place in each unit that includes the header
 * (runtime-pack-common/scripts/native-units.mjs).
 *
 * The allocator state is ScrSaState: the global scr_sa, or in worker
 * executables the `sa` field of the thread-local ScrThreadHot. Where the
 * allocator is compiled out (SCR_SMALL_ALLOC is 0), the entry points are
 * the system allocator's. */
import {
  Size,
  Uint32,
  Uintptr,
  type CStruct,
  type Extern,
  type FixedArray,
  type Inline,
  type Pointer,
  type RawPointer,
  type ThreadLocal,
  type Uint8,
  addressOf,
  calloc,
  cast,
  free,
  inline,
  malloc,
  memset,
  target,
  toAddress,
} from "@scriptc/experimental/native";

export interface ScrSaBlock extends CStruct<"ScrSaBlock"> {
  next: ScrSaBlock | null;
}

export interface ScrSaState extends CStruct<"ScrSaState"> {
  base: Uintptr;
  span: Uintptr;
  shift: Uint32;
  free: FixedArray<ScrSaBlock | null, 40>;
  bump: FixedArray<Pointer<Uint8>, 40>;
  lim: FixedArray<Pointer<Uint8>, 40>;
}

export interface ScrThreadHot extends CStruct<"ScrThreadHot"> {
  sa: Inline<ScrSaState>;
  cyc_live: Size;
  cyc_old_freed: Size;
  weak_dispose_hook: ((o: RawPointer) => void) | null;
}

declare const scr_sa_global: Extern<ScrSaState, "scr_sa">;
declare const scr_thread_hot: ThreadLocal<ScrThreadHot>;
declare function scr_sa_slow(n: Size, zero: boolean): RawPointer | null;
declare function scr_sa_free_foreign(p: RawPointer | null): void;

/* scr_rc.h's SCR_SMALL_ALLOC. */
const SMALL_ALLOC = !(
  target.rcAudit ||
  target.sanitized ||
  target.os === "wasi" ||
  target.os === "windows" ||
  target.pointerBytes !== 8n ||
  (target.library && target.threadInstances)
);

/* The C macro scr_sa. */
const scr_sa = target.workers ? scr_thread_hot.sa : scr_sa_global;

const SCR_SA_FINE_MAX = 128n;
const SCR_SA_WIDE = 6n;
const SCR_SA_MAX = 512n;

/** The class of a block of n bytes, 1 <= n <= SCR_SA_MAX. */
export const scr_sa_class = inline(function scr_sa_class(n: Size): Uint32 {
  const k = Uint32((n - 1n) >> 3n);
  return k < SCR_SA_FINE_MAX / 8n ? k : (k + SCR_SA_FINE_MAX / 8n) >> 1n;
});

/** The block size of class c. */
export const scr_sa_class_size = inline(function scr_sa_class_size(c: Uint32): Size {
  if (c < SCR_SA_FINE_MAX / 8n) return Size(c + 1n + Uint32(c === SCR_SA_WIDE)) * 8n;
  return Size(c + 1n - SCR_SA_FINE_MAX / 16n) * 16n;
});

export const scr_sa_take = inline(function scr_sa_take(n: Size, zero: boolean): RawPointer | null {
  if (n - 1n < SCR_SA_MAX) {
    // n == 0 wraps to the slow path
    const c = scr_sa_class(n);
    const b = scr_sa.free.get(c);
    if (b !== null) {
      scr_sa.free.set(c, b.next);
      // recycled blocks are dirty
      if (zero) memset(addressOf(b), 0n, n);
      return addressOf(b);
    }
    const sz = scr_sa_class_size(c);
    const p = scr_sa.bump.get(c);
    // fresh mmap memory is zero
    if (Size(scr_sa.lim.get(c).diff(p)) >= sz) {
      scr_sa.bump.set(c, p.at(sz));
      return p;
    }
  }
  return scr_sa_slow(n, zero);
});

export const scr_mem_alloc = inline(function scr_mem_alloc(n: Size): RawPointer | null {
  if (SMALL_ALLOC) return scr_sa_take(n, false);
  return malloc(n);
});

export const scr_mem_calloc = inline(function scr_mem_calloc(n: Size): RawPointer | null {
  if (SMALL_ALLOC) return scr_sa_take(n, true);
  return calloc(1n, n);
});

export const scr_mem_free = inline(function scr_mem_free(p: RawPointer | null): void {
  if (SMALL_ALLOC) {
    const off = toAddress(p) - scr_sa.base;
    if (off < scr_sa.span) {
      const b = cast<ScrSaBlock>(p).get();
      const c = Uint32(off >> Uintptr(scr_sa.shift));
      b.next = scr_sa.free.get(c);
      scr_sa.free.set(c, b);
      return;
    }
    if (target.workers) scr_sa_free_foreign(p);
    else free(p);
  } else free(p);
});

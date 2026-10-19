"use native";
/* One function per lowering rule the native-unit tests check. */
import {
  Int32,
  Uint8,
  Uint64,
  cold,
  inline,
  likely,
  loadUnaligned,
  noinline,
  type Pointer,
  type Size,
} from "@scriptc/experimental/native";

const LIMIT = 16n;

export function signedAdd(a: Int32, b: Int32): Int32 {
  return a + b;
}

export function unsignedDivide(a: Uint64, b: Uint64): Uint64 {
  return (a / b) >> 3n;
}

export function narrow(value: Uint64): Uint8 {
  return Uint8(value);
}

export function widen(value: Int32): Uint64 {
  return Uint64(value);
}

export function countUp(n: Size): Size {
  let total: Size = 0n;
  for (let i: Size = 0n; i < n; i++) total += i;
  return total;
}

export function byteAt(p: Pointer<Uint8>, i: Size): Uint64 {
  return Uint64(p.at(i).get());
}

export function word(p: Pointer<Uint8>): Uint64 {
  return loadUnaligned<Uint64>(p);
}

export function store(p: Pointer<Uint8>, value: Uint8): void {
  p.set(value);
}

export function isSmall(n: Size): boolean {
  return likely(n < LIMIT) && n !== 0n;
}

export function isLarge(n: Size): boolean {
  const large = n >= LIMIT;
  return large;
}

export const hinted = inline(function hinted(x: Uint64): Uint64 {
  return x ^ (x >> 7n);
});

export const rare = cold(
  noinline(function rare(x: Uint64): Uint64 {
    return hinted(x) * 3n;
  }),
);

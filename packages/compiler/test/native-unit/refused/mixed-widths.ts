"use native";
import type { Uint32, Uint64 } from "@scriptc/experimental/native";
export function f(a: Uint32, b: Uint64): Uint64 {
  return a + b;
}

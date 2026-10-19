"use native";
import type { Uint32 } from "@scriptc/experimental/native";
export function f(x: Uint32): boolean {
  return x == 0n;
}

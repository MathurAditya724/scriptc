"use native";
import type { Uint32 } from "@scriptc/experimental/native";
export function f(x: Uint32): Uint32 {
  if (x === 0n) throw new Error("zero");
  return x;
}

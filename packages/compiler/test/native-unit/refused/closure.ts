"use native";
import type { Uint32 } from "@scriptc/experimental/native";
export function f(x: Uint32): Uint32 {
  const g = (y: Uint32): Uint32 => y;
  return g(x);
}

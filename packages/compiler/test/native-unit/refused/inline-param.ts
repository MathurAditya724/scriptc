"use native";
import { type CStruct, type Inline, type Size } from "@scriptc/experimental/native";

interface Pair extends CStruct<"Pair"> {
  a: Size;
  b: Size;
}

export function sum(p: Inline<Pair>): Size {
  return p.a + p.b;
}

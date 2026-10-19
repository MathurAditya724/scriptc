"use native";
import { type CStruct, type FixedArray, type Size } from "@scriptc/experimental/native";

type Count = number;

interface Table extends CStruct<"Table"> {
  slots: FixedArray<Size, Count>;
}

export function first(t: Table): Size {
  return t.slots.get(0n);
}

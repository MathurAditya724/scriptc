"use native";
import { type Size, toAddress, nullPointer, type Pointer } from "@scriptc/experimental/native";

const start = toAddress(nullPointer<Size>());

export function at(p: Pointer<Size>): Size {
  return Size(toAddress(p) - start);
}

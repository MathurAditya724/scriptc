"use native";
import { Size, target } from "@scriptc/experimental/native";

export function pointerBytes(): Size {
  return target.pointerBytes;
}

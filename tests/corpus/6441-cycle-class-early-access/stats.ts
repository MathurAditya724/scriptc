import { Sink } from "./log.ts";

function tryMake(): string {
  try {
    return new Sink("early").tag;
  } catch (error) {
    return `${(error as Error).name}: ${(error as Error).message}`;
  }
}

export const early = tryMake();

export function probe(): string {
  return new Sink("probe").tag;
}

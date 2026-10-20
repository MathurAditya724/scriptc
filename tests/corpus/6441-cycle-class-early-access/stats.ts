import { Sink, Sink as Renamed, limit as cap } from "./log.ts";

function attempt(run: () => string): string {
  try {
    return run();
  } catch (error) {
    return `${(error as Error).name}: ${(error as Error).message}`;
  }
}

// Each early access throws Node's ReferenceError, naming the binding the
// access spells: construction, a static method read as a value, the class
// and a constant through renamed imports.
export const early = attempt(() => new Sink("early").tag);
export const earlyMethod = attempt(() => {
  const describe = Sink.describe;
  return typeof describe;
});
export const earlyRenamed = attempt(() => new Renamed("renamed").tag);
export const earlyCap = attempt(() => String(cap));

export function probe(): string {
  return `${new Sink("probe").tag} ${Sink.describe()} ${new Renamed("probe").tag} ${cap}`;
}

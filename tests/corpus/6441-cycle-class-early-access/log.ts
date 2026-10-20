import { probe } from "./stats.ts";

export class Sink {
  readonly tag: string;
  constructor(tag: string) {
    this.tag = tag;
  }
}

export const probed = probe();

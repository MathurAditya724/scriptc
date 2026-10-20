import { probe } from "./stats.ts";

export class Sink {
  readonly tag: string;
  constructor(tag: string) {
    this.tag = tag;
  }
  static describe(): string {
    return "sink";
  }
}

export const limit = 3;

export const probed = probe();

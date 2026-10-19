import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { DYN_HANDLE_KINDS } from "../../ir/ir.js";
import { DYN_HANDLE_TAG_NUM } from "./dyn.js";

// ScrDynHandleTag in scr_dyn.h lists its tags by name, each with an explicit
// value, so changes that add tags edit different lines. These checks stand
// in for what the enum's order used to guarantee.
const header = readFileSync(new URL("../../../../runtime/src/scr_dyn.h", import.meta.url), "utf8");
const body = /typedef enum \{\n([\s\S]*?)\} ScrDynHandleTag;/.exec(header)![1]!;
const tags = [...body.matchAll(/^\s*(SCR_DYNH_[A-Z0-9_]+) = (\d+),/gm)].map(([, name, value]) => ({
  name: name!,
  value: Number(value),
}));
const capacity = Number(/#define SCR_DYNH_CAPACITY (\d+)/.exec(header)![1]);

test("every ScrDynHandleTag has an explicit value, in name order", () => {
  const lines = body.split("\n").filter((line) => line.trim().startsWith("SCR_DYNH_"));
  expect(tags.length).toBe(lines.length);
  expect(tags.map((tag) => tag.name)).toEqual(tags.map((tag) => tag.name).toSorted());
});

test("ScrDynHandleTag values are unique and below SCR_DYNH_CAPACITY", () => {
  const owners = new Map<number, string>();
  for (const { name, value } of tags) {
    expect(owners.get(value), `${name} = ${value}`).toBeUndefined();
    owners.set(value, name);
    expect(value, name).toBeLessThan(capacity);
  }
});

test("the backend's handle tag numbers match scr_dyn.h", () => {
  const values = new Map(tags.map((tag) => [tag.name, tag.value]));
  for (const [kind, num] of Object.entries(DYN_HANDLE_TAG_NUM)) {
    const tag = DYN_HANDLE_KINDS.get(kind)?.tag;
    expect(tag, kind).toBeDefined();
    expect(values.get(tag!), `${kind} (${tag})`).toBe(num);
  }
});

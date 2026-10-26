import { expect, test } from "vitest";
import { moduleTagNumber } from "./stable-names.js";

test("module tag numbers depend only on the file name and stay distinct", () => {
  const first = moduleTagNumber("lib/a.ts", new Set());
  expect(moduleTagNumber("lib/a.ts", new Set([7, 8]))).toBe(first);
  expect(moduleTagNumber("lib/b.ts", new Set())).not.toBe(first);
  expect(moduleTagNumber("lib/a.ts", new Set([first]))).toBe((first + 1) >>> 0);
  expect(moduleTagNumber("lib/a.ts", new Set([first, (first + 1) >>> 0]))).toBe((first + 2) >>> 0);
});

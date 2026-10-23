import { describe, expect, test } from "vitest";
import { applyEdits, isDeclBoundaryFile, isDeclBoundaryTypeName } from "./decl-projection.js";

describe("decl-projection", () => {
  test("applyEdits nests wraps that close at one position", () => {
    const text = "const p = a.b;";
    // Outer wrap of `a.b` and inner wrap of `a`... closing at different ends;
    // two wraps closing at the same position close the inner one first.
    const out = applyEdits(text, [
      { start: 10, end: 10, text: "(" },
      { start: 13, end: 13, text: " as Outer)", rank: -10 },
      { start: 10, end: 10, text: "(" },
      { start: 13, end: 13, text: " as Inner)", rank: -9 },
    ]);
    expect(out).toBe("const p = ((a.b as Inner) as Outer);");
  });

  test("applyEdits keeps the first of overlapping replacements and every line", () => {
    const text = "type A = z.infer<typeof S>;\nconst x = 1;";
    const out = applyEdits(text, [
      { start: 9, end: 26, text: "__scriptc_decl_0" },
      { start: 11, end: 16, text: "nope" },
    ]);
    expect(out).toBe("type A = __scriptc_decl_0;\nconst x = 1;");
  });

  test("names", () => {
    expect(isDeclBoundaryTypeName("__scriptc_decl_3")).toBe(true);
    expect(isDeclBoundaryTypeName("Product")).toBe(false);
    expect(isDeclBoundaryFile("/app/src/__scriptc_decl_boundary__.d.ts")).toBe(true);
    expect(isDeclBoundaryFile("/app/src/types.d.ts")).toBe(false);
  });
});

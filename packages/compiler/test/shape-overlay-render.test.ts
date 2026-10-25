/* renderShapeOverlay keeps the package's JSDoc as written (package JSDoc is
 * a declaration) and writes the annotations a build keeps. */
import { expect, test } from "vitest";
import { OVERLAY_MARK, renderShapeOverlay } from "../src/frontend/shape-inference/overlay.js";
import type { ShapeOverlayPlan } from "../src/frontend/shape-inference/overlay.js";

test("package JSDoc stays as written; dropped annotations are left out", () => {
  const decls = [
    "/** @param {string} a */\nfunction f(a, b) {}\n",
    "/** @type {number} */\nvar x = 1;\n",
    "function g(c) {}\n",
  ];
  const text = decls.join("");
  const edits: { pos: number; id: number; text: string }[] = [];
  const at: number[] = [];
  let lo = 0;
  for (const decl of decls) {
    const pos = lo + (decl.startsWith("/**") ? decl.indexOf("\n") + 1 : 0);
    at.push(pos);
    edits.push({ pos, id: pos, text: `/** @param {number} b ${OVERLAY_MARK} #${pos} */ ` });
    lo += decl.length;
  }
  const plan: ShapeOverlayPlan = { parts: new Map([["a.js", { text, edits, suffix: "" }]]) };
  const overlay = renderShapeOverlay(plan, {
    annotations: new Map([["a.js", new Set([at[1]!])]]),
    files: new Set(),
  });
  const out = overlay.files.get("a.js")!;
  expect(out).toContain("/** @param {string} a */\n/** @param {number} b");
  expect(out).toContain("/** @type {number} */\nvar x = 1;");
  expect(out).not.toContain(`#${at[1]}`);
  expect(out).toContain(`#${at[2]} */ function g(c) {}`);
  expect(overlay.annotations).toBe(2);
});

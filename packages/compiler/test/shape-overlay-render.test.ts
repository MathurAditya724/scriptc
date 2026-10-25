/* renderShapeOverlay neutralizes the package JSDoc in the leading trivia of
 * the annotations a build keeps, and leaves the trivia of dropped ones. */
import { expect, test } from "vitest";
import {
  neutralizeDocTags,
  OVERLAY_MARK,
  renderShapeOverlay,
} from "../src/frontend/shape-inference/overlay.js";
import type { ShapeOverlayPlan } from "../src/frontend/shape-inference/overlay.js";

test("each kept annotation's leading JSDoc is neutralized, once per range", () => {
  const decls = [
    "/** @param {string} a */\nfunction f(a) {}\n",
    "/** @type {number} */\nvar x = 1;\n",
    "/** @returns {void} */\nfunction g() {}\n",
  ];
  const text = decls.join("");
  const docRanges: { lo: number; hi: number; id: number }[] = [];
  const edits: { pos: number; id: number; text: string }[] = [];
  let lo = 0;
  for (const decl of decls) {
    const hi = lo + decl.indexOf("\n") + 1;
    docRanges.push({ lo, hi, id: hi });
    // A declaration's first child starts at the same position: its range is
    // the same trivia.
    docRanges.push({ lo, hi, id: hi });
    edits.push({ pos: hi, id: hi, text: `/** @type {any} ${OVERLAY_MARK} #${hi} */ ` });
    lo += decl.length;
  }
  const plan: ShapeOverlayPlan = {
    parts: new Map([["a.js", { text, edits, suffix: "", docRanges }]]),
  };
  const dropped = docRanges[2]!.id;
  const overlay = renderShapeOverlay(plan, {
    annotations: new Map([["a.js", new Set([dropped])]]),
    files: new Set(),
  });
  const annotated = (decl: string, keep: boolean, at: number): string => {
    const head = decl.slice(0, decl.indexOf("\n") + 1);
    const rest = decl.slice(head.length);
    return keep
      ? `${neutralizeDocTags(head)}/** @type {any} ${OVERLAY_MARK} #${at} */ ${rest}`
      : decl;
  };
  expect(overlay.files.get("a.js")).toBe(
    decls
      .map((decl, i) => annotated(decl, docRanges[2 * i]!.id !== dropped, docRanges[2 * i]!.id))
      .join(""),
  );
  expect(overlay.files.get("a.js")).toContain("/** @type {number} */");
  expect(overlay.files.get("a.js")).toContain("/** -param {string} a */");
  expect(overlay.annotations).toBe(2);
});

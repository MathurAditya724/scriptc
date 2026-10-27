import { expect, test } from "vitest";
import { ambientSurfaceFns, builtinModuleFns } from "../frontend/lowering/surfaces.js";
import { STRING } from "../ir/ir.js";
import { resolveLibraryFences } from "../library/fence-eval.js";
import { generateSurfaceManifest } from "./surface-manifest.js";

test("module callable projections retain one ambient cwd surface and its fence witness", () => {
  const entries = generateSurfaceManifest("test").entries.filter(
    (entry) => entry.id === "node-builtin.process.cwd",
  );
  expect(entries).toEqual([
    { id: "node-builtin.process.cwd", kind: "node-builtin", name: "process.cwd", status: "static" },
  ]);
  expect(ambientSurfaceFns().filter((row) => row.id === entries[0]!.id)).toHaveLength(1);
  const resolved = resolveLibraryFences([{ id: entries[0]!.id, path: "fences[0]" }]);
  expect(resolved.ok).toBe(true);
  if (!resolved.ok) return;
  expect(resolved.fences.flatMap((fence) => fence.surfaces)).toEqual([
    expect.objectContaining({ detector: expect.objectContaining({ libFns: ["process.cwd"] }) }),
  ]);
});

test("unrelated module projections still reject duplicate ambient capability ids", () => {
  const processFns = builtinModuleFns()["process"]!;
  const previous = processFns["pid"];
  try {
    // A pid-labelled cwd implementation is not the ambient process.pid capability.
    processFns["pid"] = { fn: "process.cwd", params: [], result: STRING };
    expect(() => generateSurfaceManifest("test")).toThrow(
      "duplicate manifest id: node-builtin.process.pid",
    );
  } finally {
    if (previous === undefined) delete processFns["pid"];
    else processFns["pid"] = previous;
  }
});

test("callable projections cannot replace an ambient effect witness", () => {
  const processFns = builtinModuleFns()["process"]!;
  const previous = processFns["cwd"]!;
  try {
    processFns["cwd"] = { ...previous, valueFn: "process.envGet" };
    expect(() => generateSurfaceManifest("test")).toThrow(
      "duplicate manifest id: node-builtin.process.cwd",
    );
  } finally {
    processFns["cwd"] = previous;
  }
});

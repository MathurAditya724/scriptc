import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { normalizeCliArgs } from "../cli/usage.js";
import { clearResolveCaches, resolveSourceOverlayModule, sourceOverlayPaths } from "./resolve.js";
import {
  activeSourceOverlays,
  beginSourceOverlayCompile,
  dropSourceOverlay,
  findSourceManifest,
  installSourceOverlays,
  loadSourceManifest,
  sourceOverlayFallbacks,
  takeSourceOverlayProblems,
} from "./source-overlays.js";

let root: string;

/** A pnpm-shaped install of `name` with an overlay beside it. */
function instance(name: string, version: string): Record<string, unknown> {
  const installedDir = join(root, "node_modules/.pnpm", `${name}@${version}`, "node_modules", name);
  mkdirSync(installedDir, { recursive: true });
  writeFileSync(join(installedDir, "package.json"), JSON.stringify({ name, version }));
  const overlayDir = join(root, ".scriptc-pm/overlay", `${name}@${version}`, "pkg");
  mkdirSync(join(overlayDir, "src"), { recursive: true });
  writeFileSync(join(overlayDir, "src/index.ts"), "export const x = 1;\n");
  return {
    installedDir,
    name,
    version,
    overlayDir,
    exports: { ".": "./src/index.ts", "./sub/*": "./src/*.ts" },
  };
}

function writeManifest(instances: Record<string, unknown>[], extra = {}): string {
  const path = join(root, ".scriptc-pm/manifest.json");
  mkdirSync(join(root, ".scriptc-pm"), { recursive: true });
  writeFileSync(path, JSON.stringify({ schema: 1, lockDigest: "sha256-a", instances, ...extra }));
  return path;
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "scriptc-overlays-")));
});

afterEach(() => {
  installSourceOverlays(null);
  clearResolveCaches();
  rmSync(root, { recursive: true, force: true });
});

test("reads schema 1, keys instances by installed realpath, and finds the manifest", () => {
  const path = writeManifest([instance("a", "1.0.0")], {
    fallbacks: [{ name: "b", version: "2.0.0", reason: "JavaScript upstream" }],
  });
  mkdirSync(join(root, "src/deep"), { recursive: true });
  expect(findSourceManifest(join(root, "src/deep/main.ts"))).toBe(path);
  const set = loadSourceManifest(path);
  expect(set.instances.map((i) => i.key)).toEqual([
    join(root, "node_modules/.pnpm/a@1.0.0/node_modules/a"),
  ]);
  expect(set.notes).toEqual(["b@2.0.0: published JS (JavaScript upstream)"]);
  expect(set.cacheIdentity).toMatch(/^sha256-a\0[0-9a-f]{64}$/);
});

test("rejects other schemas and malformed instances", () => {
  writeManifest([]);
  const path = join(root, ".scriptc-pm/manifest.json");
  writeFileSync(path, JSON.stringify({ schema: 2, lockDigest: "x", instances: [] }));
  expect(() => loadSourceManifest(path)).toThrow(/unsupported schema 2/);
  writeFileSync(path, JSON.stringify({ schema: 1, lockDigest: "x", instances: [{ name: "a" }] }));
  expect(() => loadSourceManifest(path)).toThrow(/instances\[0\]\.installedDir/);
});

test("redirects imports that land in an instance, and the checker paths agree", () => {
  const a = instance("a", "1.0.0");
  installSourceOverlays(loadSourceManifest(writeManifest([a])));
  beginSourceOverlayCompile();
  symlinkSync(
    join(root, "node_modules/.pnpm/a@1.0.0/node_modules/a"),
    join(root, "node_modules/a"),
  );
  const main = join(root, "main.ts");
  const overlay = a["overlayDir"] as string;
  expect(resolveSourceOverlayModule(main, "a")).toBe(join(overlay, "src/index.ts"));
  expect(resolveSourceOverlayModule(main, "a/sub/index")).toBe(join(overlay, "src/index.ts"));
  expect(sourceOverlayPaths()).toEqual({
    a: [join(overlay, "src/index.ts")],
    "a/sub/*": [join(overlay, "src/*.ts")],
  });
  // A subpath the overlay does not export is a problem the frontend drops for.
  expect(resolveSourceOverlayModule(main, "a/missing")).toBeNull();
  expect([...takeSourceOverlayProblems().values()]).toEqual([
    "'a/missing' is not exported by the overlay",
  ]);
  dropSourceOverlay(a["installedDir"] as string, "test");
  expect(resolveSourceOverlayModule(main, "a")).toBeNull();
  expect(sourceOverlayPaths()).toBeNull();
  beginSourceOverlayCompile();
  expect(activeSourceOverlays()).toHaveLength(1);
});

test("names with several augmented instances start dropped", () => {
  const one = instance("a", "1.0.0");
  const two = instance("a", "2.0.0");
  installSourceOverlays(loadSourceManifest(writeManifest([one, two])));
  beginSourceOverlayCompile();
  expect(activeSourceOverlays()).toEqual([]);
  expect(sourceOverlayFallbacks().map((f) => f.reason)).toEqual([
    "ambiguous-name: 2 augmented instances of a (only single-instance names are redirected)",
    "ambiguous-name: 2 augmented instances of a (only single-instance names are redirected)",
  ]);
});

test("--sources takes an optional inline value", () => {
  expect(normalizeCliArgs(["build", "--sources", "m.ts"])).toEqual(["build", "--sources=", "m.ts"]);
  expect(normalizeCliArgs(["--sources=x.json", "--", "--sources"])).toEqual([
    "--sources=x.json",
    "--",
    "--sources",
  ]);
});

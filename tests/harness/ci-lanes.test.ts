import { readFileSync } from "node:fs";
import { load } from "js-yaml";
import { expect, test } from "vitest";
import { select } from "../../scripts/ci-lanes.mjs";

type Selection = { on: Record<string, boolean>; reasons: string[] };
const lanesOf = (files: string[], lines: { file: string; text: string }[] = []) =>
  (select(files, lines) as Selection).on;

test.each([
  [
    "a compiler change",
    ["packages/compiler/src/backend/emit.ts"],
    { linux: true, macos: false, effects: false, bootstrap: false },
  ],
  [
    "a runtime C change",
    ["packages/runtime/src/scr_array.c"],
    { linux: true, macos: false, effects: false, bootstrap: false },
  ],
  [
    "a corpus program",
    ["tests/corpus/1234-example.ts"],
    { linux: true, macos: false, effects: false, bootstrap: false },
  ],
  [
    "documentation only",
    ["docs/content/guide.mdx", "README.md"],
    { linux: false, macos: false, effects: false, bootstrap: false },
  ],
  [
    "a darwin package",
    ["packages/runtime-darwin-arm64/scripts/build.mjs"],
    { linux: true, macos: true, effects: false, bootstrap: false },
  ],
  [
    "the LLVM helper",
    ["native/llvm-codegen/src/emit.cpp"],
    { linux: true, macos: true, effects: false, bootstrap: false },
  ],
  [
    "a darwin test file",
    ["tests/harness/ffi-frameworks.test.ts"],
    { linux: true, macos: true, effects: false, bootstrap: false },
  ],
  [
    "the Effect harness",
    ["tests/harness/effect.test.ts"],
    { linux: true, macos: false, effects: true, bootstrap: false },
  ],
  [
    "the bootstrap scripts",
    ["scripts/build-native-cli.mts"],
    { linux: true, macos: false, effects: false, bootstrap: true },
  ],
  [
    "CI configuration",
    [".github/workflows/ci.yml"],
    { linux: true, macos: true, effects: true, bootstrap: true },
  ],
  [
    "this script",
    ["scripts/ci-lanes.mjs"],
    { linux: true, macos: true, effects: true, bootstrap: true },
  ],
  [
    "the lockfile",
    ["pnpm-lock.yaml"],
    { linux: true, macos: true, effects: true, bootstrap: true },
  ],
  [
    "a package manifest",
    ["packages/compiler/package.json"],
    { linux: true, macos: true, effects: true, bootstrap: true },
  ],
  [
    "the shard partitioner",
    ["tests/harness/shard.ts"],
    { linux: true, macos: true, effects: true, bootstrap: true },
  ],
])("CI lanes for %s", (_name, files, expected) => {
  expect(lanesOf(files)).toEqual(expected);
});

test("a changed line that mentions a darwin-specific API runs the macOS lane", () => {
  const file = "packages/runtime/src/scr_event_loop.c";
  expect(lanesOf([file], [{ file, text: "#if defined(__APPLE__)" }]).macos).toBe(true);
  expect(lanesOf([file], [{ file, text: "  epoll_wait(fd, events, n, timeout);" }]).macos).toBe(
    false,
  );
  expect(lanesOf([file], [{ file, text: "  struct kevent change;" }]).macos).toBe(true);
});

test("CI runs the base commit's lane selection against the pull request's diff", () => {
  const workflow = load(
    readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8"),
  ) as { jobs: Record<string, { steps: { id?: string; run?: string }[] }> };
  const script = workflow.jobs["lanes"]!.steps.find((step) => step.id === "lanes")!.run!;
  expect(script).toContain('git show "$BASE:scripts/ci-lanes.mjs"');
  expect(script).toContain(
    'node "$RUNNER_TEMP/ci-lanes.mjs" --base "$BASE" --head "$HEAD" --github-output',
  );
  // Pushes and the nightly sweep, and a base without the script, run every lane.
  expect(script.match(/every$/gm)).toHaveLength(2);
});

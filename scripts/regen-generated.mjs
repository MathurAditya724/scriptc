#!/usr/bin/env node
/* Regenerates the committed generated files from their sources, so a merge
 * never resolves one by hand:
 *
 *   packages/compiler/surface-manifest.json          pnpm manifest
 *   internal/compatibility/generated/node-v24-internal.json
 *   docs/src/generated/node-v24-compatibility.json   pnpm node-compat --local
 *
 * During a merge, resolve the conflicts in source files first. Each
 * generated file git still reports as conflicted is then replaced by the
 * merged-in branch's version (MERGE_HEAD; HEAD during a rebase or
 * cherry-pick, where HEAD is the branch being built on), every file is
 * regenerated from the merged sources, and the conflicted ones are staged.
 *
 *   node scripts/regen-generated.mjs
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const GENERATED = [
  "packages/compiler/surface-manifest.json",
  "internal/compatibility/generated/node-v24-internal.json",
  "docs/src/generated/node-v24-compatibility.json",
];

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: ["ignore", "pipe", "inherit"] });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stdout.write(result.stdout);
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`);
  }
  return result.stdout.toString();
}

const git = (...args) => run("git", args);
const hasRef = (ref) =>
  spawnSync("git", ["rev-parse", "-q", "--verify", ref], { cwd: root }).status === 0;

const unmerged = new Set(git("diff", "--name-only", "--diff-filter=U").split("\n"));
const conflicted = GENERATED.filter((path) => unmerged.has(path));
if (conflicted.length > 0) {
  const from = hasRef("MERGE_HEAD") ? "MERGE_HEAD" : "HEAD";
  git("checkout", from, "--", ...conflicted);
  console.log(`took ${from}'s ${conflicted.join(", ")}`);
}
process.stdout.write(run("pnpm", ["--silent", "manifest"]));
process.stdout.write(run(process.execPath, ["internal/compatibility/src/generate.mjs", "--local"]));
if (conflicted.length > 0) {
  git("add", "--", ...conflicted);
  console.log(`staged ${conflicted.join(", ")}`);
}

#!/usr/bin/env node
// Refreshes scripts/ci-test-costs.json from the logs of the Linux test shards of green CI runs on main.
//
// Usage: node scripts/ci-test-costs.mjs <job log> ...
//
// Each log is a downloaded "test (Linux, plain|san, i/n)" job log. vitest prints every test file it ran with its
// duration; for each file that runs in the side queue (not the case-sharded corpus, Effect, coverage and cache
// suites) this stores the median over the logs of its flavor. Files without a measurement keep their current
// value.
import { readFileSync, writeFileSync } from "node:fs";
import { fileExclusions, isolatedFiles } from "./ci-test-plan.mjs";

const path = new URL("./ci-test-costs.json", import.meta.url);
const table = JSON.parse(readFileSync(path, "utf8"));
const skipped = new Set(
  fileExclusions.filter((file) => !isolatedFiles.some(([, isolated]) => isolated === file)),
);
const samples = { plain: {}, san: {} };
for (const log of process.argv.slice(2)) {
  // Logs keep the terminal color codes (ESC [ ... m); drop them before matching.
  const text = readFileSync(log, "utf8")
    .replaceAll(String.fromCharCode(27), "")
    .replace(/\[[0-9;]*m/g, "");
  const flavor = /SCRIPTC_SAN: 1\b/.test(text) ? "san" : "plain";
  for (const line of text.split("\n")) {
    const m = /^\S+ {2}✓ (\S+\.test\.ts) \(\d+ tests?[^)]*\) (\d+)ms$/.exec(line);
    if (!m || skipped.has(m[1])) continue;
    (samples[flavor][m[1]] ??= []).push(Number(m[2]));
  }
}
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
let updated = 0;
for (const flavor of ["plain", "san"])
  for (const [file, values] of Object.entries(samples[flavor])) {
    table[flavor][file] = median(values);
    updated++;
  }
for (const flavor of ["plain", "san"])
  table[flavor] = Object.fromEntries(
    Object.entries(table[flavor]).sort(([a], [b]) => a.localeCompare(b)),
  );
writeFileSync(path, JSON.stringify(table, null, 2) + "\n");
console.log(`updated ${updated} file costs`);

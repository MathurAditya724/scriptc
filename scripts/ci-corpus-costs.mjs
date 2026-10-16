#!/usr/bin/env node
// Refreshes tests/harness/corpus-costs.json from the logs of the Linux test shards of green CI runs on main.
//
// Usage: node scripts/ci-corpus-costs.mjs <job log> ...
//
// Each log is a downloaded "test (Linux, plain|san, i/10)" job log. vitest prints every case slower than its
// threshold with its duration; for each program this takes the median of its differential and of its
// llvm-differential case over the logs of its flavor, and stores their sum. Programs without a measurement keep
// their current value.
import { readFileSync, writeFileSync } from "node:fs";

const path = new URL("../tests/harness/corpus-costs.json", import.meta.url);
const table = JSON.parse(readFileSync(path, "utf8"));
const samples = { plain: {}, san: {} };
for (const log of process.argv.slice(2)) {
  // Logs keep the terminal color codes (ESC [ ... m); drop them before matching.
  const text = readFileSync(log, "utf8")
    .replaceAll(String.fromCharCode(27), "")
    .replace(/\[[0-9;]*m/g, "");
  const flavor = /SCRIPTC_SAN: 1\b/.test(text) ? "san" : "plain";
  for (const line of text.split("\n")) {
    const m =
      /^\S+\s+✓ (llvm differential corpus|differential corpus) \(.*?\) > (.*?) {2}(\d+)ms$/.exec(
        line,
      );
    if (!m) continue;
    const lane = m[1] === "differential corpus" ? "differential" : "llvm";
    (samples[flavor][m[2]] ??= { differential: [], llvm: [] })[lane].push(Number(m[3]));
  }
}
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
let updated = 0;
for (const flavor of ["plain", "san"])
  for (const [key, lanes] of Object.entries(samples[flavor])) {
    table[flavor][key] = median(lanes.differential) + median(lanes.llvm);
    updated++;
  }
for (const flavor of ["plain", "san"])
  table[flavor] = Object.fromEntries(
    Object.entries(table[flavor]).sort(([a], [b]) => a.localeCompare(b)),
  );
writeFileSync(path, JSON.stringify(table, null, 2) + "\n");
console.log(`updated ${updated} program costs`);

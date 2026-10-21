#!/usr/bin/env node
/* Assembles a development libnode pack from the pinned, checksum-verified
 * inputs in dev-pack.json: a prebuilt libnode of the repository's Node
 * release and Node's official headers, with the bridge built against them
 * by build-pack.mjs. CI's Linux test lanes use it (.github/actions/
 * libnode-dev-pack) until the NI-13 packs are published.
 *
 *   node packages/libnode-common/fetch-dev-pack.mjs --out <pack directory> */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const here = fileURLToPath(new URL(".", import.meta.url));
const { values } = parseArgs({ options: { out: { type: "string" } } });
if (!values.out) {
  console.error("usage: fetch-dev-pack.mjs --out <pack directory>");
  process.exit(2);
}
const platform = `${process.platform}-${process.arch}`;
const pins = JSON.parse(readFileSync(join(here, "dev-pack.json"), "utf8"))[platform];
if (pins === undefined) {
  console.error(`dev-pack.json pins no libnode for ${platform}`);
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), "scriptc-libnode-dev-"));

async function fetchVerified({ url, sha256 }, name) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== sha256) throw new Error(`${url}: sha256 ${actual}, expected ${sha256}`);
  const path = join(work, name);
  writeFileSync(path, bytes);
  execFileSync("tar", ["-xzf", path, "-C", work]);
}

await fetchVerified(pins.libnode, "libnode.tar.gz");
await fetchVerified(pins.headers, "headers.tar.gz");
mkdirSync(resolve(values.out), { recursive: true });
execFileSync(
  process.execPath,
  [
    join(here, "build-pack.mjs"),
    "--libnode",
    join(work, pins.libnode.file),
    "--headers",
    join(work, pins.headers.dir),
    "--out",
    resolve(values.out),
  ],
  { stdio: "inherit" },
);

// fs.realpath 1.0.0 (vendored unmodified, ISC) keeps Node's own functions as
// values (`var origRealpathSync = fs.realpathSync`, `origRealpath = fs.realpath`)
// and calls them with its legacy cache object as the options argument.
// glob 7 and 8 reach the filesystem through it.
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import rp from "fs.realpath";

const dir = mkdtempSync(join(tmpdir(), "scriptc-fs-realpath-"));
mkdirSync(join(dir, "real"));
writeFileSync(join(dir, "real", "f.txt"), "x");
symlinkSync(join(dir, "real"), join(dir, "link"));
console.log(rp.realpathSync(join(dir, "link", "f.txt"), {}).endsWith("/real/f.txt"));
rp.realpath(join(dir, "link", "f.txt"), {}, (err: Error | null, resolved?: string) => {
  console.log(err === null, String(resolved).endsWith("/real/f.txt"));
});

// fs.Stats values held in untyped JavaScript bindings, as glob's lstat
// handling does: the binding stores Node's Stats object, and its type tests
// and fields read through it.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function kind(p) {
  var lstat;
  try {
    lstat = fs.lstatSync(p);
  } catch (er) {
    if (er.code === 'ENOENT') return 'missing';
  }
  var isSym = lstat && lstat.isSymbolicLink();
  if (!isSym && lstat && !lstat.isDirectory()) return 'file ' + lstat.size;
  return 'dir';
}

const cache = {};
function cachedStat(p) {
  if (!cache[p]) cache[p] = fs.statSync(p);
  return cache[p];
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptc-stats-js-'));
const file = path.join(dir, 'a');
fs.writeFileSync(file, 'abc');
console.log(kind(dir), kind(file), kind(path.join(dir, 'nope')));
const st = cachedStat(file);
console.log(st.isFile(), st.size, st.mtimeMs > 0, st.mtime instanceof Date, cachedStat(file) === st);
fs.rmSync(dir, { recursive: true });

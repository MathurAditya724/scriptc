// fs.stat and fs.lstat callbacks under @types/node: the result parameter is
// Node's Stats object, read through its fields, dates and type tests.
import { stat, lstat, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const dir = mkdtempSync(join(tmpdir(), 'scriptc-stats-cb-'));
const file = join(dir, 'f.txt');
writeFileSync(file, 'hello');
stat(file, (error, result) => {
  if (error) return;
  console.log(result.size, result.mtimeMs > 0, result.isFile(), result.isDirectory());
  console.log(result.mtime instanceof Date, result.mtime.getTime() > 0, typeof result.mode);
  lstat(dir, (lstatError, info) => {
    if (lstatError || !info.isDirectory()) return;
    console.log('dir', info.isSymbolicLink(), info.nlink > 0);
    rmSync(dir, { recursive: true });
  });
});
stat(join(dir, 'missing'), (error) => console.log('missing', error?.code));

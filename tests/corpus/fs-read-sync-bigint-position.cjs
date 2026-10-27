'use strict';
// BigInt positions use the signed-64-bit file offset range, independently
// of Number's MAX_SAFE_INTEGER, and positioned reads preserve the fd cursor.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptc-read-bigint-'));
const file = path.join(dir, 'data');
fs.writeFileSync(file, 'abcdef');
const fd = fs.openSync(file, 'r');

function attempt(label, fn) {
  try {
    console.log(label, fn());
  } catch (error) {
    console.log(label, error.name, error.code, error.message);
  }
}

function readAt(position) {
  const buffer = Buffer.alloc(1);
  return fs.readSync(fd, buffer, 0, 1, position) + ':' + buffer[0];
}

try {
  attempt('zero', () => readAt(0n));
  attempt('one', () => readAt(1n));
  attempt('safe bigint', () => readAt(9007199254740991n));
  attempt('two to 53', () => readAt(9007199254740992n));
  attempt('odd above safe', () => readAt(9007199254740993n));
  attempt('signed limit minus length', () => readAt(9223372036854775806n));

  attempt('cursor first', () => readAt(null));
  attempt('positioned eof', () => readAt(9007199254740993n));
  attempt('cursor second', () => readAt(-1n));
  attempt('positioned one', () => readAt(1n));
  attempt('cursor third', () => readAt(undefined));

  const shared = new Uint8Array(new SharedArrayBuffer(4));
  console.log('shared read', fs.readSync(fd, shared, 1, 2, 2n), shared.join(','));
  console.log('shared eof', fs.readSync(fd, shared, 0, 1, 9007199254740993n), shared.join(','));

  const backing = new ArrayBuffer(6);
  const view = new DataView(backing, 1, 4);
  console.log('view read', fs.readSync(fd, view, 1, 2, 3n), new Uint8Array(backing).join(','));
  console.log('view eof', fs.readSync(fd, view, 0, 1, 9007199254740993n), new Uint8Array(backing).join(','));

  attempt('zero length signed max', () => fs.readSync(fd, Buffer.alloc(0), 0, 0, 9223372036854775807n));
  attempt('negative bigint', () => readAt(-2n));
  attempt('past signed limit', () => readAt(9223372036854775807n));
  attempt('past signed limit zero length', () => fs.readSync(fd, Buffer.alloc(0), 0, 0, 9223372036854775808n));
  attempt('unsafe number', () => readAt(9007199254740992));
  attempt('fractional number', () => readAt(0.5));
  attempt('negative number', () => readAt(-2));
  attempt('offset before position', () => fs.readSync(fd, Buffer.alloc(1), -1, 1, 9223372036854775808n));

  let calls = 0;
  const length = { valueOf: () => (++calls, 1) };
  console.log('length conversion', fs.readSync(fd, Buffer.alloc(1), 0, length, 9007199254740993n), calls);
} finally {
  fs.closeSync(fd);
  fs.rmSync(dir, { recursive: true });
}

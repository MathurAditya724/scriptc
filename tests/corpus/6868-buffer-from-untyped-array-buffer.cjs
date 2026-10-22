// Buffer.from over an untyped ArrayBuffer or SharedArrayBuffer (read from a
// Map, an untyped object field or a worker message): the Buffer covers the
// whole buffer and shares its memory, in both directions, as in Node. An
// encoding name in the second argument converts to byte offset 0.
'use strict';
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');

if (isMainThread) {
  const store = new Map();
  store.set('plain', new ArrayBuffer(6));
  store.set('shared', new SharedArrayBuffer(6));
  for (const key of ['plain', 'shared']) {
    const storage = store.get(key);
    const buf = Buffer.from(storage);
    buf[1] = 0x41;
    new Uint8Array(storage)[2] = 0x42;
    console.log(key, buf.length, Buffer.isBuffer(buf), buf.toString('hex'), new Uint8Array(storage).join(','));
    const encoded = Buffer.from(storage, 'utf8');
    console.log(key, 'with encoding', encoded.length, encoded.toString('hex'));
  }

  const holder = JSON.parse('{}');
  holder.data = new ArrayBuffer(3);
  const view = Buffer.from(holder.data);
  view.write('xyz');
  console.log('field', Buffer.from(holder.data).toString());

  const sab = new SharedArrayBuffer(8);
  const worker = new Worker(__filename, { workerData: sab });
  worker.on('message', (message) => {
    const seen = Buffer.from(message.storage);
    console.log('worker wrote', seen.toString('latin1'), new Uint8Array(sab).join(','));
  });
} else {
  const out = Buffer.from(workerData);
  out.write('shared!');
  parentPort.postMessage({ storage: workerData });
}

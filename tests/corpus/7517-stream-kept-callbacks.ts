// Option callbacks that keep their `callback` argument: a Writable whose
// write() keeps every third callback and calls it later, a write that
// calls its callback and keeps it (`cb(); keep(cb)`) and calls it again
// after later writes (ERR_MULTIPLE_CALLBACK), and a Transform that calls
// back synchronously, from setImmediate, and from a promise. Every write
// and transform completes in Node's order.
import { Transform, Writable } from "node:stream";

type Done = (error?: Error | null) => void;

const kept: Done[] = [];
const log: string[] = [];

const deferred = new Writable({
  highWaterMark: 4,
  write(chunk: Buffer, _encoding: string, callback: Done) {
    const text = chunk.toString();
    if (Number(text) % 3 === 0) {
      kept.push(callback);
      log.push(`kept ${text}`);
      setImmediate(() => {
        const cb = kept.shift();
        log.push(`late ${text}`);
        if (cb) cb();
      });
      return;
    }
    log.push(`write ${text}`);
    callback();
  },
});
for (let i = 1; i <= 10; i++) {
  deferred.write(String(i), () => log.push(`done ${i}`));
}
deferred.end(() => {
  console.log(log.join("\n"));
  twice();
});

function twice(): void {
  let saved: Done | null = null;
  const w = new Writable({
    write(chunk: Buffer, _encoding: string, callback: Done) {
      const text = chunk.toString();
      console.log("twice write", text);
      callback();
      if (text === "a") saved = callback;
    },
  });
  w.on("error", (error: Error & { code?: string }) => {
    console.log("twice error", error.code);
  });
  w.write("a");
  w.write("b");
  w.write("c");
  setImmediate(() => {
    const cb = saved;
    if (cb) cb();
    setImmediate(transforms);
  });
}

function transforms(): void {
  let n = 0;
  const t = new Transform({
    transform(chunk: Buffer, _encoding: string, callback: (error?: Error | null, data?: Buffer) => void) {
      const k = n++;
      const out = Buffer.from(`[${chunk.toString()}]`);
      if (k % 3 === 0) callback(null, out);
      else if (k % 3 === 1) setImmediate(() => callback(null, out));
      else Promise.resolve().then(() => callback(null, out));
    },
  });
  const parts: string[] = [];
  t.on("data", (chunk: Buffer) => parts.push(chunk.toString()));
  t.on("end", () => console.log("transform", parts.join("")));
  for (let i = 0; i < 9; i++) t.write(String(i));
  t.end();
}

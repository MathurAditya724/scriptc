// Write callbacks of synchronous writes run in Node's order: consecutive
// writes with the same callback complete in one afterWrite step, ahead of
// a process.nextTick queued between them, and a write with another
// callback (or none) starts the next step; end's callback and 'finish'
// follow. A PassThrough read by 'data' runs each write's own callback.
import { PassThrough, Writable } from "node:stream";

const log: string[] = [];

function run(): Promise<void> {
  return new Promise((resolve) => {
    const w = new Writable({
      highWaterMark: 4,
      write(chunk: Buffer, _enc, cb) {
        log.push(`write ${String(chunk)}`);
        cb();
      },
    });
    const shared = (): void => {
      log.push("shared callback");
    };
    w.on("finish", () => {
      log.push("finish");
      resolve();
    });
    w.write("a", shared);
    w.write("b", shared);
    process.nextTick(() => log.push("tick between"));
    w.write("c", shared);
    w.write("d", () => log.push("own callback d"));
    w.write("e");
    w.write("f");
    queueMicrotask(() => log.push("microtask"));
    w.write("g", shared);
    w.write("h", shared);
    process.nextTick(() => log.push("tick after"));
    w.end(() => log.push("end callback"));
  });
}

function passThrough(): Promise<void> {
  return new Promise((resolve) => {
    const pt = new PassThrough({ highWaterMark: 8 });
    let bytes = 0;
    pt.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
    });
    pt.on("end", () => {
      log.push(`passthrough end ${bytes}`);
      resolve();
    });
    let i = 0;
    const more = (): void => {
      while (i < 40) {
        i++;
        const n = i;
        if (!pt.write(`chunk${n}`, () => {
          if (n % 10 === 0) log.push(`callback ${n}`);
        })) {
          pt.once("drain", more);
          return;
        }
      }
      pt.end();
    };
    more();
  });
}

async function main(): Promise<void> {
  await run();
  await passThrough();
  console.log(log.join("\n"));
}

main();

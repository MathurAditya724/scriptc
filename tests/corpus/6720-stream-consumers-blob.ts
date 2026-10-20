// stream/consumers.blob — Node's `new Blob(chunks)` over the chunks a
// stream yields: Buffer chunks contribute their bytes, string chunks their
// utf8 bytes, the type is empty, and later writes to a source chunk are not
// observed. Each chunk the stream's iterator reads is one Blob part, so the
// Blob's readers settle on the same microtask turn as Node's. Settlement lands with text()'s, after
// 'close' and before a later macrotask, and the rejection set matches the
// other consumers: the stream's error and ERR_STREAM_PREMATURE_CLOSE.
import { Readable } from "node:stream";
import { blob, text } from "node:stream/consumers";

function source(...chunks: (Buffer | string)[]): Readable {
  const r = new Readable({ read() {} });
  for (const c of chunks) r.push(c);
  r.push(null);
  return r;
}

async function main(): Promise<void> {
  const b = await blob(source(Buffer.from("hi"), Buffer.from([0xc3, 0xa9]), "!"));
  console.log(b instanceof Blob, b.size, JSON.stringify(b.type));
  console.log(await b.text());
  console.log(Array.from(new Uint8Array(await b.arrayBuffer())));
  console.log(await b.slice(1, 4).text(), b.slice(2).size);

  // Readable.from yields its strings as object-mode chunks.
  const fromStrings = await blob(Readable.from(["ab", "cé", "😀"]));
  console.log(fromStrings.size, await fromStrings.text());

  // String chunks (setEncoding) contribute their utf8 bytes.
  const encoded = new Readable({ read() {} });
  encoded.setEncoding("utf8");
  encoded.push("é");
  encoded.push("x");
  encoded.push(null);
  const decoded = await blob(encoded);
  console.log(decoded.size, await decoded.text());

  // The Blob copies its parts: a later write to a chunk is not observed.
  const chunk = Buffer.from([1, 2, 3]);
  const copied = await blob(source(chunk));
  chunk[0] = 9;
  console.log(Array.from(new Uint8Array(await copied.arrayBuffer())), chunk[0]);

  const empty = await blob(source());
  console.log(empty.size, JSON.stringify(await empty.text()));

  // Each chunk the stream's iterator reads is one Blob part: object-mode
  // entries are separate chunks, while a byte stream's buffered pushes read
  // as one. A Blob with more parts settles its text() later.
  const one = new Blob(["abc"]);
  async function race(label: string, b: Blob): Promise<void> {
    const reads: string[] = [];
    await Promise.all([
      b.text().then((t) => reads.push(`${label}:${t}`)),
      one.text().then((t) => reads.push(`one:${t}`)),
    ]);
    console.log(reads.join(","));
  }
  await race("entries", await blob(Readable.from(["a", "b", "c"])));
  await race("buffered", await blob(source("a", "b", "c")));

  // Timing: blob() settles with text() on the same stream shape, after
  // 'close' and before a setImmediate queued at end.
  const order: string[] = [];
  const first = new Readable({ read() {} });
  const second = new Readable({ read() {} });
  first.on("close", () => order.push("close"));
  const settled = Promise.all([
    blob(first).then((v) => order.push(`blob(${v.size})`)),
    text(second).then((v) => order.push(`text(${v.length})`)),
  ]);
  first.push("abc");
  first.push(null);
  second.push("abc");
  second.push(null);
  setImmediate(() => order.push("immediate"));
  await settled;
  await new Promise<void>((resolve) => setImmediate(resolve));
  console.log(order.join(","));

  const failing = new Readable({ read() {} });
  const p1 = blob(failing);
  failing.push("x");
  failing.destroy(new Error("mid-stream failure"));
  try {
    await p1;
    console.log("SHOULD NOT PRINT");
  } catch (e) {
    if (e instanceof Error) console.log("error:", e.message);
  }

  const closed = new Readable({ read() {} });
  const p2 = blob(closed);
  closed.destroy();
  try {
    await p2;
    console.log("SHOULD NOT PRINT");
  } catch (e) {
    console.log("premature:", (e as NodeJS.ErrnoException).code);
  }
}

void main();

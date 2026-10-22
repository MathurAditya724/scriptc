// Batched writes in JavaScript: the writev option in a literal and in an
// options value, and _writev on a constructor function's prototype. The
// batch entries carry chunk, encoding and callback (Node's nop when the
// write passed none), allBuffers says whether every chunk is a Buffer,
// and a stream with only _writev sends a lone write as { chunk, encoding }.
const stream = require("node:stream");
const util = require("node:util");

const log = [];
const describe = (chunks) =>
  chunks
    .map((c) => {
      const chunk = Buffer.isBuffer(c.chunk) ? "B:" + c.chunk.toString() : `${typeof c.chunk}:${c.chunk}`;
      const callback = typeof c.callback === "function" ? c.callback.name || "fn" : String(c.callback);
      return `${chunk}/${c.encoding}/${callback}`;
    })
    .join(",") +
  ` all=${chunks.allBuffers} keys=${Object.keys(chunks[0]).join(".")}`;

function viaLiteral(next) {
  const w = new stream.Writable({
    write(chunk, enc, cb) {
      log.push("write " + chunk);
      setTimeout(cb, 1);
    },
    writev(chunks, cb) {
      log.push("writev " + describe(chunks));
      setTimeout(cb, 1);
    },
  });
  w.write("a", () => log.push("cb a"));
  w.write("b", () => log.push("cb b"));
  w.write("c");
  w.write(Buffer.from("d"), () => log.push("cb d"));
  w.end(() => log.push("end"));
  w.on("finish", () => {
    log.push("finish");
    next();
  });
}

function dyn(value) {
  return value;
}

function viaValue(next) {
  const options = {
    writev(chunks, cb) {
      log.push("value " + describe(chunks));
      cb();
    },
  };
  const v = new stream.Writable(dyn(options));
  v.cork();
  v.write("x");
  v.write("6869", "hex");
  v.uncork();
  v.write("z", () => log.push("z cb"));
  v.end();
  v.on("finish", () => {
    log.push("value finish");
    next();
  });
}

function Sink(opts) {
  stream.Writable.call(this, opts);
}
util.inherits(Sink, stream.Writable);
Sink.prototype._writev = function (chunks, cb) {
  log.push("sink " + (this instanceof Sink) + " " + describe(chunks));
  cb();
};

function viaConstructor(next) {
  const s = new Sink({ decodeStrings: false });
  s.cork();
  s.write("a");
  s.write("6869", "hex");
  s.write(Buffer.from("b"));
  s.uncork();
  s.write("lone");
  s.end(() => {
    log.push("sink end");
    next();
  });
}

viaLiteral(() => viaValue(() => viaConstructor(() => console.log(log.join("\n")))));

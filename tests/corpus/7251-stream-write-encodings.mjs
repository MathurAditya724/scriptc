// Write encodings in JavaScript: decodeStrings: false and defaultEncoding
// in options literals and options values, setDefaultEncoding(), and
// strings written in other encodings to constructor-function streams.
import * as stream from "node:stream";
import { PassThrough, Transform, Writable } from "node:stream";
import * as util from "node:util";

const log = [];
const describe = (c, e) => `${Buffer.isBuffer(c) ? "B:" + c.toString("hex") : typeof c + ":" + c}/${e}`;
const dyn = (value) => value;

const keep = new Writable({ decodeStrings: false, highWaterMark: 4, write(c, e, cb) { log.push("keep " + describe(c, e)); cb(); } });
log.push("ret " + keep.write("héllo") + " length " + keep.writableLength);
keep.write("6869", "hex");
keep.write(Buffer.from("zz"));
keep.end("end", "latin1");

const valueOpts = { decodeStrings: false, defaultEncoding: "HEX", write(c, e, cb) { log.push("value " + describe(c, e)); cb(); } };
const fromValue = new Writable(dyn(valueOpts));
fromValue.write("ab");
fromValue.write(Buffer.from("c"));

const hex = new Writable({ defaultEncoding: "hex", write(c, e, cb) { log.push("hex " + describe(c, e)); cb(); } });
hex.write("6869");
hex.write("41", "utf8");
hex.setDefaultEncoding("BASE64");
hex.write("aGk=");
try {
  hex.setDefaultEncoding("nope");
} catch (e) {
  log.push("setDefaultEncoding " + e.code + " " + e.message);
}
log.push("chains " + (hex.setDefaultEncoding("utf8") === hex));

const t = new Transform({ decodeStrings: false, transform(c, e, cb) { log.push("t " + describe(c, e)); cb(null, c); } });
t.on("data", (c) => log.push("t data " + describe(c, "-")));
t.write("abc");
t.write("ff", "hex");
const p = new PassThrough({ decodeStrings: false });
p.on("data", (c) => log.push("p data " + describe(c, "-")));
p.write("q");

const om = new Writable({ objectMode: true, defaultEncoding: "hex", write(c, e, cb) { log.push("om " + describe(c, e)); cb(); } });
om.write("s");
try {
  new Writable({ defaultEncoding: "bogus" });
} catch (e) {
  log.push("constructor " + e.code);
}

function Sink() {
  stream.Writable.call(this);
}
util.inherits(Sink, stream.Writable);
Sink.prototype._write = function (c, e, cb) {
  log.push("sink " + describe(c, e));
  cb();
};
const sink = new Sink();
sink.write("6869", "hex");
sink.setDefaultEncoding("latin1");
sink.write("é");
sink.end("YQ==", "base64");

setTimeout(() => console.log(log.join("\n")), 5);

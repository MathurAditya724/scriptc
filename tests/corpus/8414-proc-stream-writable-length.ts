// process.stdout/stderr.writableLength is the bytes queued behind the last
// write. A compiled binary writes fd 1 and 2 synchronously, so nothing is
// ever queued — 0, which is also Node's answer before the first write has
// to be buffered. The reads run before the console call writes, so both
// processes answer from an empty queue.
const outLength = process.stdout.writableLength;
const errLength = process.stderr.writableLength;
console.log("writableLength:", outLength, errLength);
console.log("typeof:", typeof outLength, typeof errLength);

// The same read through a first-class ALIAS of the stream answers the
// same constant: the alias keeps the stream's type, so the read lowers
// to the synchronous-write 0 instead of a keyed runtime get.
const out = process.stdout;
const aliased = out.writableLength;
console.log("alias:", aliased, typeof aliased);

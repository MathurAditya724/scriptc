// A JavaScript ES module has no __dirname or __filename (Node throws a
// ReferenceError where they are read); import.meta carries the location.
// TypeScript files keep the CommonJS globals as the source path.
try {
  console.log(__dirname);
} catch (error) {
  console.log("no __dirname:", error instanceof Error);
}
console.log(import.meta.filename.endsWith("6271-esm-js-dirname.mjs"));

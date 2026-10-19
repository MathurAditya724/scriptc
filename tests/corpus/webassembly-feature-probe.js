// @deferred-fences: 2
// A JavaScript dependency's WebAssembly glue: the feature probe answers as
// in Node, and the loader that would instantiate a module is never reached
// (reaching it would throw scriptc's located WebAssembly fence).
function supportsWasm() {
  return typeof WebAssembly === "object" && typeof WebAssembly.instantiate === "function";
}

async function instantiate(bytes, imports) {
  const { instance } = await WebAssembly.instantiate(bytes, imports);
  return instance.exports;
}

const backend = process.argv.includes("--wasm") ? instantiate : null;
console.log("supports wasm:", supportsWasm());
console.log("backend:", backend === null ? "javascript" : "wasm");

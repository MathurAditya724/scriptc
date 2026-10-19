// The parts of the WebAssembly API scriptc does not implement yet refuse at
// each reached use, in each spelling. compile, instantiate, validate,
// Module, Instance and the error classes compile (tests/corpus/webassembly-*).
async function load(bytes: Uint8Array): Promise<void> {
  const module = await WebAssembly.compile(bytes);
  const memory = new WebAssembly.Memory({ initial: 1 });
  const table = new WebAssembly.Table({ initial: 1, element: "anyfunc" });
  const global = new WebAssembly.Global({ value: "i32", mutable: true }, 1);
  console.log(memory.buffer.byteLength, table.length, global.value);
  console.log(WebAssembly.Module.imports(module).length);
  console.log(WebAssembly.Module.customSections(module, "name").length);
  const streamed = await WebAssembly.instantiateStreaming(fetch("https://example.com/x.wasm"));
  console.log(streamed.instance);
  const Ctor = WebAssembly.Module;
  console.log(Ctor);
}

await load(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));

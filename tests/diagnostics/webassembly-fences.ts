// No WebAssembly module compiles to native code yet: every reached use of
// the API refuses at its site, in each spelling, while declarations that
// only mention its types compile.
interface LoaderOptions {
  wasm?: BufferSource | WebAssembly.Module;
  imports?: WebAssembly.Imports;
}

async function load(options: LoaderOptions, bytes: Uint8Array): Promise<void> {
  console.log(WebAssembly.validate(bytes));
  const module = await WebAssembly.compile(bytes);
  const { instance } = await WebAssembly.instantiate(bytes, options.imports);
  console.log(instance instanceof WebAssembly.Instance, module);
  const direct = new WebAssembly.Instance(new WebAssembly.Module(bytes));
  console.log(direct.exports);
  const memory = new WebAssembly.Memory({ initial: 1 });
  console.log(memory.buffer.byteLength);
  const api = globalThis.WebAssembly;
  console.log(api);
  console.log(WebAssembly.Module.imports(module).length);
}

// pi's codemode spelling: the global object viewed through a cast.
interface WebAssemblyGlobal {
  compile(bytes: Uint8Array): Promise<unknown>;
}
const { WebAssembly: viewed } = globalThis as unknown as { WebAssembly: WebAssemblyGlobal };
console.log(typeof viewed.compile);

await load({}, new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));

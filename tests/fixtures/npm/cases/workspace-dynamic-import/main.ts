// A workspace package the program loads on demand through import(): its
// own npm dependency (installed only in the workspace package's
// node_modules) compiles with it, although neither is part of the startup
// module graph.
async function main(): Promise<void> {
  console.log("before");
  const m = await import("wsdynamic");
  console.log(m.greet("world"));
}
main();

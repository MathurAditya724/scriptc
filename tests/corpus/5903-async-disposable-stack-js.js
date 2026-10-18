// AsyncDisposableStack from JavaScript: untyped resources and callbacks, the
// order of async and sync disposals against a microtask ticker, detached
// methods, and Node's TypeError, ReferenceError and rejection texts. Node.js
// prints the same.
const messages = new AsyncDisposableStack();
const t = (f) => { try { const r = f(); console.log("ok", r); } catch (e) { console.log(e.name + ": " + e.message); } };
const { use, defer, move, disposeAsync, adopt } = messages;
t(() => use(null));
t(() => defer.call({}, () => {}));
t(() => move.call(5));
disposeAsync.call({}).catch((e) => console.log("rejected", e.name + ": " + e.message));
t(() => messages.adopt(1, 2));
t(() => messages.use(5));
t(() => messages.use({}));
console.log(messages.disposeAsync.name, messages.disposeAsync.length, messages[Symbol.asyncDispose] === messages.disposeAsync, messages.use.length, messages.adopt.length, messages.defer.length, messages.move.length, typeof messages.dispose);
console.log(String(messages), JSON.stringify(messages), messages);
messages.disposeAsync().then(() => { t(() => messages.defer(() => {})); t(() => messages.move()); console.log(messages.disposed); });
const m = new AsyncDisposableStack(); m.defer(() => console.log("moved ran")); const n = m.move(); console.log(m.disposed, n.disposed, n instanceof AsyncDisposableStack, n instanceof DisposableStack); n.disposeAsync();
const order = [];
async function orderTicker(n) { for (let i = 0; i < n; i++) { order.push("t" + i); await null; } }
async function main() {
  const tick = orderTicker(12);
  const s = new AsyncDisposableStack();
  s.defer(() => { order.push("sync defer"); });
  s.defer(async () => { order.push("async defer start"); await null; order.push("async defer end"); });
  s.use({ [Symbol.dispose]() { order.push("sync use"); } });
  s.use({ async [Symbol.asyncDispose]() { order.push("async use"); } });
  s.adopt(1, (v) => { order.push("adopt " + v); });
  s.use(null);
  const p = s.disposeAsync();
  order.push("returned " + (typeof p.then));
  await p;
  order.push("done " + s.disposed);
  await s.disposeAsync();
  order.push("again");
  await tick;
  console.log(order.join("\n"));
  const e = new AsyncDisposableStack();
  e.defer(async () => { throw new Error("a"); });
  e.defer(() => { throw new Error("b"); });
  try { await e.disposeAsync(); } catch (err) { console.log(err.name, err.error.message, err.suppressed.message); }
  try { e.use({}); } catch (err) { console.log(err.name, err.message); }
  const f = new AsyncDisposableStack(); void 0; console.log(typeof f.dispose, typeof f[Symbol.asyncDispose], String(f));
  try { new AsyncDisposableStack().use(3); } catch (err) { console.log(err.message); }
  try { new AsyncDisposableStack().use({}); } catch (err) { console.log(err.message); }
  console.log(new AsyncDisposableStack());
}
main();

// AsyncDisposableStack: disposeAsync interleaved with a microtask ticker (each
// awaited result, a throwing callback, absent resources, failures), class
// resources with [Symbol.asyncDispose] or [Symbol.dispose], await using over
// a stack, move, SuppressedError chains, and stacks whose callbacks capture
// the stack. Node.js prints the same.
const log: string[] = [];
async function ticker(label: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    log.push(label + i);
    await null;
  }
}
async function scenario(name: string, build: (s: AsyncDisposableStack) => void): Promise<void> {
  log.length = 0;
  const s = new AsyncDisposableStack();
  build(s);
  const tick = ticker("t", 14);
  const p = s.disposeAsync().then(
    () => log.push("resolved"),
    (e: unknown) => log.push("rejected " + (e instanceof Error ? e.message : String(e))),
  );
  log.push("sync end");
  await p;
  await tick;
  console.log(name + ": " + log.join(" "));
}
async function timings(): Promise<void> {
  await scenario("empty", () => {});
  await scenario("one sync defer", (s) => s.defer(() => { log.push("d"); }));
  await scenario("one async defer", (s) => s.defer(async () => { log.push("d"); }));
  await scenario("two defers", (s) => {
    s.defer(() => { log.push("d1"); });
    s.defer(() => { log.push("d2"); });
  });
  await scenario("sync use", (s) => { s.use({ [Symbol.dispose]() { log.push("u"); } }); });
  await scenario("async use", (s) => { s.use({ async [Symbol.asyncDispose]() { log.push("u"); } }); });
  await scenario("null use", (s) => { s.use(null); });
  await scenario("null then defer", (s) => { s.defer(() => { log.push("d"); }); s.use(null); });
  await scenario("defer then null", (s) => { s.use(undefined); s.defer(() => { log.push("d"); }); });
  await scenario("adopt", (s) => { s.adopt(3, (v) => { log.push("a" + v); }); });
  await scenario("slow async", (s) => s.defer(async () => { log.push("d start"); await null; await null; log.push("d end"); }));
  await scenario("throws", (s) => s.defer(() => { throw new Error("boom"); }));
  await scenario("rejects", (s) => s.defer(async () => { throw new Error("boom"); }));
  await scenario("two failures", (s) => {
    s.defer(() => { throw new Error("first"); });
    s.defer(async () => { throw new Error("second"); });
  });
  await scenario("returns promise", (s) => s.defer(() => Promise.resolve()));
  await scenario("already disposed", (s) => { void s.disposeAsync(); });
}

const events: string[] = [];
class AsyncResource {
  readonly name: string;
  constructor(name: string) {
    this.name = name;
  }
  async [Symbol.asyncDispose](): Promise<void> {
    events.push("async start " + this.name);
    await null;
    events.push("async end " + this.name);
  }
}
class SyncResource {
  readonly name: string;
  constructor(name: string) {
    this.name = name;
  }
  [Symbol.dispose](): void {
    events.push("sync " + this.name);
  }
}
class Both extends SyncResource {
  async [Symbol.asyncDispose](): Promise<void> {
    events.push("both async " + this.name);
  }
}
class FailingAsync {
  async [Symbol.asyncDispose](): Promise<void> {
    throw new Error("async failure");
  }
}
async function eventTicker(n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    events.push("t" + i);
    await null;
  }
}
async function main(): Promise<void> {
  const tick = eventTicker(10);
  {
    await using stack = new AsyncDisposableStack();
    const a = stack.use(new AsyncResource("a"));
    stack.use(new SyncResource("s"));
    stack.use(new Both("b"));
    stack.adopt(new SyncResource("adopted"), async (r) => {
      events.push("adopt " + r.name);
    });
    stack.defer(() => {
      events.push("defer");
    });
    events.push("got " + a.name + " " + stack.disposed);
  }
  events.push("after block");
  await tick;
  console.log(events.join("\n"));
  events.length = 0;

  const outer = new AsyncDisposableStack();
  outer.use(new SyncResource("moved"));
  const moved = outer.move();
  console.log(outer.disposed, moved.disposed, moved instanceof AsyncDisposableStack, moved instanceof DisposableStack);
  await moved.disposeAsync();
  await moved.disposeAsync();
  console.log(events.join(","), moved.disposed);

  const failing = new AsyncDisposableStack();
  failing.use(new FailingAsync());
  failing.defer(() => {
    throw new TypeError("sync failure");
  });
  failing.use(new FailingAsync());
  try {
    await failing.disposeAsync();
  } catch (e) {
    const chain: string[] = [];
    let cur: unknown = e;
    while (cur instanceof SuppressedError) {
      chain.push((cur.error as Error).message);
      cur = cur.suppressed;
    }
    chain.push((cur as Error).message);
    console.log(chain.join(" <- "));
  }
  try {
    await using s = new AsyncDisposableStack();
    s.defer(async () => {
      throw new Error("disposal");
    });
    throw new Error("body");
  } catch (e) {
    if (e instanceof SuppressedError) console.log(e.name, (e.error as Error).message, (e.suppressed as Error).message);
  }
  for (let i = 0; i < 3; i++) {
    const cyc = new AsyncDisposableStack();
    cyc.defer(() => console.log("never", cyc.disposed));
  }
  const shown = new AsyncDisposableStack();
  console.log(shown, String(shown), JSON.stringify(shown), typeof shown.disposeAsync);
  const sync = new DisposableStack();
  sync.defer(() => console.log("sync stack inside async"));
  await using wrapper = new AsyncDisposableStack();
  wrapper.use(sync);
  console.log("end of main");
}
void timings().then(() => main());

// AsyncLocalStorage across stackless async bodies: a call inherits the
// caller's context when it starts, keeps it across every await even after
// the caller's run() window closed, nested runs inside the body shadow and
// restore around awaits, enterWith inside a body stays inside that body,
// and concurrent bodies keep their own contexts while their continuations
// interleave on the microtask queue and across timers.
import { AsyncLocalStorage } from "node:async_hooks";

const store = new AsyncLocalStorage<string>();
const log: string[] = [];
const say = (s: string): void => {
  log.push(s);
};
const current = (): string => store.getStore() ?? "none";

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function worker(id: number, ms: number): Promise<string> {
  say("worker " + id + " start " + current());
  await null;
  say("worker " + id + " after hop " + current());
  await sleep(ms);
  say("worker " + id + " after sleep " + current());
  const inner = await store.run("inner" + id, async () => {
    await null;
    return current();
  });
  say("worker " + id + " inner " + inner + " back " + current());
  return current();
}

async function entering(): Promise<string> {
  say("entering start " + current());
  store.enterWith("entered");
  await Promise.resolve();
  say("entering after await " + current());
  return current();
}

async function main(): Promise<void> {
  const a = store.run("a", () => worker(1, 2));
  const b = store.run("b", () => worker(2, 1));
  const c = worker(3, 0);
  say("main after spawns " + current());
  const all: Promise<string>[] = [a, b, c];
  const results = await Promise.all(all);
  say("results " + results.join(" "));
  const e = await store.run("outer", () => entering());
  say("entering returned " + e + " main sees " + current());
  await store.run("chain", async () => {
    const first = await worker(4, 0);
    const second = await worker(5, 1);
    say("chain " + first + " " + second);
  });
  say("main end " + current());
}

main().then(() => {
  for (const line of log) console.log(line);
});

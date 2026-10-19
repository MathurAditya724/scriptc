// util.promisify over typed callback-only functions (a bound method, a
// function declaration, an inline arrow): the error argument rejects, the
// value fulfills, a synchronous throw rejects, and settlement is async.
import { promisify } from "node:util";

class Connection {
  private closed = false;
  private readonly name: string;
  constructor(name: string) {
    this.name = name;
  }
  close(callback: (error?: Error) => void): void {
    setTimeout(() => {
      if (this.closed) {
        callback(new Error(`${this.name} already closed`));
        return;
      }
      this.closed = true;
      callback();
    }, 1);
  }
  stats(callback: (error: Error | null, open: number) => void): void {
    setImmediate(() => (this.closed ? callback(new RangeError("closed"), 0) : callback(null, 3)));
  }
}

function boom(callback: (error: Error | null) => void): void {
  if (callback !== undefined) throw new TypeError("synchronous failure");
}

async function main(): Promise<void> {
  const c = new Connection("db");
  const stats = promisify(c.stats.bind(c));
  console.log("open", await stats());
  const closeAsync = promisify(c.close.bind(c));
  await closeAsync();
  console.log("closed once");
  try {
    await closeAsync();
  } catch (e) {
    console.log("second close:", (e as Error).message);
  }
  try {
    await stats();
  } catch (e) {
    console.log("stats:", (e as Error).name, (e as Error).message);
  }
  try {
    await promisify(boom)();
  } catch (e) {
    console.log("sync throw:", (e as Error).name, (e as Error).message);
  }
  const order: string[] = [];
  const tick = promisify((done: (error?: Error) => void) => {
    order.push("called");
    done();
  });
  const p = tick().then(() => order.push("settled"));
  order.push("returned");
  await p;
  console.log(order.join(", "));
  await promisify(new Connection("inline").close.bind(new Connection("inline")))();
  console.log("inline done");
}
void main();

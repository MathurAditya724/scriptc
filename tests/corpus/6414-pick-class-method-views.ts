// `Pick<C, K>` and `Omit<C, K>` over a class, used as structural parameter
// and field types: a view of the instance's own members. Calls through the
// view run the instance's methods on the instance itself, so its state is
// shared with every other reference.
class ApiClient {
  private readonly base: string;
  calls = 0;
  constructor(base: string) {
    this.base = base;
  }
  request(path: string): Promise<string> {
    this.calls++;
    return Promise.resolve(this.base + path);
  }
  close(): void {
    console.log("closed after", this.calls);
  }
}

interface Context {
  client: Pick<ApiClient, "request">;
  name: string;
}

async function run(ctx: Context): Promise<void> {
  console.log(ctx.name, await ctx.client.request("/x"), await ctx.client.request("/y"));
}
function finish(client: Pick<ApiClient, "request" | "close">): void {
  client.close();
}
function count(client: Omit<ApiClient, "close">): number {
  return client.calls;
}

const client = new ApiClient("https://h");
void run({ client, name: "ctx" }).then(() => {
  finish(client);
  console.log(count(client), client.calls);
});

// A live view that flows into another structural type keeps the instance:
// reads through the second view see the instance's later writes.
interface Counter {
  calls: number;
}
function counted(view: Pick<ApiClient, "request" | "calls">): Counter {
  void view.request("/z");
  return view;
}
const second = new ApiClient("https://k");
const counter = counted(second);
second.calls += 10;
const holder: { counter: Counter } = { counter: counted(second) };
second.calls = 100;
console.log("counter", counter.calls, holder.counter.calls, second.calls);

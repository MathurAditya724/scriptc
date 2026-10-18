// A small "application" that uses several augmented packages together.
import { Sema } from "async-sema";
import { InMemoryProvider, OpenFeature } from "@openfeature/server-sdk";
import { match } from "path-to-regexp";
import { parse } from "smol-toml";

const config = parse(`[routes]\nuser = "/user/:id"\n[limits]\nconcurrency = 2\n`) as {
  routes: { user: string };
  limits: { concurrency: number };
};
await OpenFeature.setProviderAndWait(
  new InMemoryProvider({
    "greet": { variants: { yes: true, no: false }, defaultVariant: "yes", disabled: false },
  }),
);
const flags = OpenFeature.getClient();
const route = match<{ id: string }>(config.routes.user);
const sema = new Sema(config.limits.concurrency);
const out: string[] = [];
await Promise.all(
  ["/user/1", "/user/2", "/nope"].map(async (path) => {
    await sema.acquire();
    const hit = route(path);
    const greet = await flags.getBooleanValue("greet", false);
    out.push(hit === false ? `${path}: 404` : `${path}: ${greet ? "hello" : "hi"} ${hit.params.id}`);
    sema.release();
  }),
);
console.log(out.sort().join("\n"));
await OpenFeature.close();

import { InMemoryProvider, OpenFeature } from "@openfeature/server-sdk";

const provider = new InMemoryProvider({
  "new-ui": { variants: { on: true, off: false }, defaultVariant: "on", disabled: false },
  "color": { variants: { red: "red", blue: "blue" }, defaultVariant: "blue", disabled: false },
});
await OpenFeature.setProviderAndWait(provider);
const client = OpenFeature.getClient();
console.log(await client.getBooleanValue("new-ui", false));
console.log(await client.getStringValue("color", "none"));
const details = await client.getBooleanDetails("missing", false);
console.log(`${details.flagKey} ${details.value} ${details.reason} ${details.errorCode}`);
await OpenFeature.close();

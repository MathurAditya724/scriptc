import { InMemoryProvider, OpenFeature } from "@openfeature/server-sdk";

const provider = new InMemoryProvider({
  "new-ui": { variants: { on: true, off: false }, defaultVariant: "on", disabled: false },
  greeting: {
    variants: { formal: "Good day", casual: "Hey" },
    defaultVariant: "casual",
    disabled: false,
  },
});
await OpenFeature.setProviderAndWait(provider);
const client = OpenFeature.getClient("demo");
console.log("new-ui", await client.getBooleanValue("new-ui", false));
console.log("greeting", await client.getStringValue("greeting", "Hello"));
const details = await client.getStringDetails("missing", "fallback");
console.log("missing", details.value, details.reason, details.errorCode);
await OpenFeature.close();

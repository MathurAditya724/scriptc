// events.once lowers for EventEmitter instances and literal event names;
// these forms stay refused.
import { EventEmitter, once } from "node:events";

const ee = new EventEmitter();
const name: string = process.argv[2] ?? "ready";
async function main(): Promise<void> {
  await once(ee, "ready", { signal: AbortSignal.timeout(5) }); // options
  await once(ee, name); // computed event name
}
void main();

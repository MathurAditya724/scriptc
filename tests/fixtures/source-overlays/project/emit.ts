import mitt, { type Emitter } from "mitt";

type Events = { greet: string; count: number };
const emitter: Emitter<Events> = mitt<Events>();
const seen: string[] = [];
const onGreet = (name: string): void => {
  seen.push(`hello ${name}`);
};
emitter.on("greet", onGreet);
emitter.on("count", (n) => seen.push(`count ${n * 2}`));
emitter.on("*", (type, payload) => seen.push(`* ${String(type)} ${JSON.stringify(payload)}`));
emitter.emit("greet", "world");
emitter.emit("count", 21);
emitter.off("greet", onGreet);
emitter.emit("greet", "again");
console.log(seen.join("\n"));
console.log("handlers", emitter.all.size, emitter.all.get("greet")?.length ?? 0);
emitter.all.clear();
emitter.emit("count", 1);
console.log("cleared", seen.length);

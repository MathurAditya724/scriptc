// A typed Event subclass: the constructor validates like Event's, the
// inherited accessors and methods read and change the event's own state,
// and the listener receives the instance itself, with its own fields.
import { inspect } from "node:util";

class Ping extends Event {
  readonly sequence: number;
  note = "";

  constructor(sequence: number, cancelable: boolean) {
    super("ping", { cancelable, bubbles: true });
    this.sequence = sequence;
  }

  describe(): string {
    return `${this.type}#${this.sequence} cancelable=${this.cancelable} prevented=${this.defaultPrevented}`;
  }
}

const target = new EventTarget();
target.addEventListener("ping", (event: Event) => {
  const ping = event as Ping;
  ping.note = "seen";
  console.log("listener", ping.describe(), event.eventPhase, ping.composedPath().length);
  event.preventDefault();
});

const first = new Ping(1, true);
console.log(first.describe(), first.bubbles, first.composed, first.isTrusted, first.eventPhase);
console.log("dispatch", target.dispatchEvent(first), first.describe(), first.note);
console.log(first.target === target, first.currentTarget, first.composedPath().length);

const second = new Ping(2, false);
console.log("dispatch", target.dispatchEvent(second), second.describe(), second.returnValue);

// returnValue = false is preventDefault for a cancelable event.
const third = new Ping(3, true);
third.returnValue = false;
console.log(third.defaultPrevented, third.returnValue);

// stopImmediatePropagation skips the remaining listeners.
const quiet = new EventTarget();
quiet.addEventListener("ping", (event: Event) => {
  console.log("first listener");
  event.stopImmediatePropagation();
});
quiet.addEventListener("ping", () => console.log("never"));
const stopped = new Ping(4, false);
quiet.dispatchEvent(stopped);
console.log("cancelBubble", stopped.cancelBubble);

console.log(first instanceof Ping, first instanceof Event, first instanceof CustomEvent);
const loose: unknown = first;
console.log(inspect(first, { depth: -1 }), JSON.stringify(loose), Object.keys(first).join(","));

class Untyped extends Event {
  constructor() {
    // @ts-expect-error the type argument is required
    super();
  }
}
try {
  new Untyped();
} catch (err) {
  console.log((err as Error).name, (err as { code?: string }).code, (err as Error).message);
}

import { ThreadSlots } from "@scriptc/experimental";

// ThreadSlots (@scriptc/experimental) forms scriptc refuses: names that are
// not string literals, one name opened with two value types, key and value
// types the slots cannot hold, calls through values other than a
// module-level const, and the class or its methods as values.

class Key {
  readonly id = 0;
}
class State {
  count = 0;
}
interface Shape {
  readonly id: number;
}

const name = "dynamic";
const named = new ThreadSlots<Key, State>(name);
const first = new ThreadSlots<Key, State>("fences.shared");
const second = new ThreadSlots<Key, Key>("fences.shared");
const shaped = new ThreadSlots<Shape, State>("fences.shaped");
const callbacks = new ThreadSlots<Key, () => number>("fences.callbacks");
function local(slots: ThreadSlots<Key, State>, key: Key): State | undefined {
  return slots.get(key);
}
const ctor = ThreadSlots;
const getter = first.get;
console.log(named, second, shaped, callbacks, local(first, new Key()), ctor, getter);

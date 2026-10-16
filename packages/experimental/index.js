// @scriptc/experimental — the Node.js implementation.
//
// scriptc builds lower these exports to compiler intrinsics. Under Node.js
// a LifetimeRegion is an ordinary object: run() calls its callback and
// release() does nothing, since the garbage collector reclaims what the
// program no longer references. An InternTable is a Map per name and
// thread: Node.js threads share no objects, so every thread has its own
// tables, and stored values are published (deep-frozen) as in scriptc.

import { publish } from "@scriptc/threads";

export class LifetimeRegion {
  /** Calls `fn` and returns its result. */
  run(fn) {
    return fn();
  }

  /** Does nothing under Node.js. */
  release() {}
}

/** This thread's tables, by name. */
const tables = new Map();

export class InternTable {
  #entries;

  /** Opens the table called `name`. */
  constructor(name) {
    if (typeof name !== "string") throw new TypeError("The table name must be a string");
    let entries = tables.get(name);
    if (entries === undefined) tables.set(name, (entries = new Map()));
    this.#entries = entries;
  }

  /** The number of entries. */
  get size() {
    return this.#entries.size;
  }

  /** The value stored under `key`, or undefined. */
  get(key) {
    return this.#entries.get(key);
  }

  /** Whether `key` has a value. */
  has(key) {
    return this.#entries.has(key);
  }

  /** The value stored under `key`; when there is none, publishes `value`,
   * stores it and returns it. */
  getOrInsert(key, value) {
    const entries = this.#entries;
    if (entries.has(key)) return entries.get(key);
    publish(value);
    entries.set(key, value);
    return value;
  }

  /** The value stored under `key`; when there is none, publishes
   * `callback(key)` and stores it, unless the callback stored a value under
   * `key` itself. Returns the stored value. */
  getOrInsertComputed(key, callback) {
    const entries = this.#entries;
    if (entries.has(key)) return entries.get(key);
    const value = publish(callback(key));
    if (entries.has(key)) return entries.get(key);
    entries.set(key, value);
    return value;
  }
}

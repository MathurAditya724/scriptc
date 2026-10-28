"use strict";
/* The Node island bootstrap: the main script of the Node environment that
 * scr_node_island.c loads into the process on the first call into Node.
 * scr_node_island_host.h embeds this file as a C string; regenerate it
 * with `node scripts/node-island-host.mjs` after every change.
 *
 * The libnode bridge (scr_node_bridge.cc) installs its natives (`settle`,
 * and for the hosted loop `run` and `listen`) as
 * globalThis.__scriptcNodeIslandHost before this script runs, and takes the
 * dispatcher this script leaves as globalThis.__scriptcNodeIsland
 * afterwards (`call` and the hosted-loop helpers); it deletes both globals.
 *
 * A copy of the call semantics lives in packages/node/index.js, which runs
 * them in-process under Node: both must produce the same results, errors
 * and messages. Outcomes are "R<json>" (returned; "R" alone is undefined)
 * or "T<json>" (threw), the encoding of scr_node_bridge.h. */
const { createRequire, registerHooks } = require("node:module");
const { constants: osConstants } = require("node:os");
const timers = require("node:timers");

const nativeHost = globalThis.__scriptcNodeIslandHost;

// The program's island module tree (scr_node_island.c prefixes this script
// with its root, then the bridge removes the global): modules resolve only
// to files inside it, never to a file elsewhere on the machine.
const islandRoot = globalThis.__scriptcNodeIslandRoot;
delete globalThis.__scriptcNodeIslandRoot;
if (typeof islandRoot === "string" && islandRoot !== "/") {
  const { realpathSync } = require("node:fs");
  const { sep } = require("node:path");
  const { fileURLToPath } = require("node:url");
  const root = realpathSync(islandRoot);
  const inside = root.endsWith(sep) ? root : root + sep;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const result = nextResolve(specifier, context);
      if (result.url.startsWith("file:") && !fileURLToPath(result.url).startsWith(inside)) {
        const error = new Error(
          `Cannot find module '${specifier}': it is not one of the modules this program ships`,
        );
        error.code = "MODULE_NOT_FOUND";
        throw error;
      }
      return result;
    },
  });
}

// Error classes that cross as copies, at their scr_error.h kind index.
const ERROR_KINDS = [
  [TypeError, 1],
  [RangeError, 2],
  [SyntaxError, 3],
  [ReferenceError, 5],
  [EvalError, 6],
  [URIError, 7],
];

const requires = new Map();

function exportedFunction(file, specifier, name) {
  let load = requires.get(file);
  if (load === undefined) {
    load = createRequire(file);
    requires.set(file, load);
  }
  const namespace = load(specifier);
  const fn = namespace === null || namespace === undefined ? undefined : namespace[name];
  if (typeof fn !== "function")
    throw new TypeError(`'${name}' exported by '${specifier}' is not a function`);
  return { fn, namespace };
}

function isThenable(value) {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof value.then === "function"
  );
}

function invokeSync(file, specifier, name, args) {
  const { fn, namespace } = exportedFunction(file, specifier, name);
  const result = Reflect.apply(fn, namespace, args);
  if (isThenable(result)) {
    // The promise is dropped: its rejection must not end the process.
    Promise.resolve(result).catch(() => {});
    throw new TypeError(
      `callSync: '${name}' exported by '${specifier}' returned a promise; use call() for asynchronous functions`,
    );
  }
  return result;
}

async function invokeAsync(file, specifier, name, args) {
  const { fn, namespace } = exportedFunction(file, specifier, name);
  return await Reflect.apply(fn, namespace, args);
}

function errorKind(error) {
  for (const [constructor, kind] of ERROR_KINDS) if (error instanceof constructor) return kind;
  return 0;
}

// A thrown value crosses as a copy: an Error as its nearest intrinsic
// class with its message and string code, anything else as JSON data. An
// error whose class, message or code cannot be read crosses as an Error
// with an empty message.
function thrown(error) {
  try {
    return thrownCopy(error);
  } catch {
    return 'T{"error":{"kind":0,"message":""}}';
  }
}

function thrownCopy(error) {
  if (error instanceof Error) {
    const copy = { kind: errorKind(error), message: String(error.message) };
    if (typeof error.code === "string") copy.code = error.code;
    return `T${JSON.stringify({ error: copy })}`;
  }
  let text;
  try {
    text = JSON.stringify(error);
  } catch {
    text = undefined;
  }
  return text === undefined ? 'T{"undefined":true}' : `T{"value":${text}}`;
}

function returned(result) {
  let text;
  try {
    text = JSON.stringify(result);
  } catch (error) {
    return thrown(error);
  }
  return text === undefined ? "R" : `R${text}`;
}

function call(id, sync, file, specifier, name, argsJson) {
  const args = JSON.parse(argsJson);
  if (sync) {
    let result;
    try {
      result = invokeSync(file, specifier, name, args);
    } catch (error) {
      return thrown(error);
    }
    return returned(result);
  }
  invokeAsync(file, specifier, name, args).then(
    (result) => nativeHost.settle(id, returned(result)),
    (error) => nativeHost.settle(id, thrown(error)),
  );
  return undefined;
}

// ── the hosted loop (scope-B NI-3) ─────────────────────────────────────
// The runtime's ticks, timers and immediates are Node's, created here with
// Node's own timers (captured now, so island code replacing the globals
// does not reach them) and run through the native `run`. Handles name the
// Node objects until the runtime clears them.

const JOB_TICK = 2;
const JOB_TIMER = 3;
const JOB_IMMEDIATE = 4;
const handles = new Map();
let nextHandle = 1;

function onTick(token) {
  nativeHost.run(JOB_TICK, token);
}

function onTimer(token) {
  nativeHost.run(JOB_TIMER, token);
}

function onImmediate(handle, token) {
  handles.delete(handle);
  nativeHost.run(JOB_IMMEDIATE, token);
}

function setTimer(delay, repeat, ref, token) {
  let timer;
  if (repeat > 0 && delay === repeat) {
    timer = timers.setInterval(onTimer, repeat, token);
  } else {
    timer = timers.setTimeout(onTimer, delay, token);
    // An interval migrated mid-period: its first run comes after the rest
    // of the period, later ones every `repeat` (Node re-arms a Timeout
    // whose _repeat is set, exactly as for setInterval).
    if (repeat > 0) timer._repeat = repeat;
  }
  if (!ref) timer.unref();
  const handle = nextHandle++;
  handles.set(handle, timer);
  return handle;
}

function clearTimer(handle) {
  const timer = handles.get(handle);
  if (timer === undefined) return;
  handles.delete(handle);
  timers.clearTimeout(timer);
}

function refTimer(handle, ref) {
  const timer = handles.get(handle);
  if (timer !== undefined) {
    if (ref) timer.ref();
    else timer.unref();
  }
}

function refreshTimer(handle) {
  const timer = handles.get(handle);
  if (timer !== undefined) timer.refresh();
}

function setImmediateJob(ref, token) {
  const handle = nextHandle++;
  const immediate = timers.setImmediate(onImmediate, handle, token);
  if (!ref) immediate.unref();
  handles.set(handle, immediate);
  return handle;
}

function clearImmediateJob(handle) {
  const immediate = handles.get(handle);
  if (immediate === undefined) return;
  handles.delete(handle);
  timers.clearImmediate(immediate);
}

function refImmediate(handle, ref) {
  refTimer(handle, ref);
}

function nextTick(token) {
  process.nextTick(onTick, token);
}

// ── process state (scope-B NI-3) ─────────────────────────────────────────
// Signal and 'exit' listeners of island code join the runtime's registries
// at their registration position, so one registry orders both sides and
// the runtime keeps owning every signal disposition: Node's own handlers,
// which would hand a signal to libuv and reset it to SIG_DFL when the last
// listener goes, are taken off. The listeners stay on `process` (listeners
// and listenerCount answer as in Node); the runtime calls them through
// `emit`, and Node's own 'exit' emission is left to the runtime's exit
// sequence.

const EVENT_SIGNAL = 1;
const EVENT_EXIT = 2;
const signalNames = new Set(Object.keys(osConstants.signals));
const islandListeners = [];
let nextListener = 1;

function eventKind(event) {
  if (event === "exit") return EVENT_EXIT;
  return typeof event === "string" && signalNames.has(event) ? EVENT_SIGNAL : 0;
}

for (const [event, name] of [
  ["newListener", "startListeningIfSignal"],
  ["removeListener", "stopListeningIfSignal"],
]) {
  for (const listener of process.listeners(event)) {
    if (listener.name === name) process.removeListener(event, listener);
  }
}

process.on("newListener", (event, listener) => {
  const kind = eventKind(event);
  if (kind === 0) return;
  const id = nextListener++;
  islandListeners.push({ event, listener, id, raw: undefined });
  nativeHost.listen(kind, event, id, 1, 0);
});

function forget(i, kind) {
  const entry = islandListeners[i];
  islandListeners.splice(i, 1);
  nativeHost.listen(kind, entry.event, entry.id, 0, 0);
}

process.on("removeListener", (event, listener) => {
  const kind = eventKind(event);
  if (kind === 0) return;
  // Node reports the removed registration as the raw listener it installed (a
  // once wrapper removing itself reports the wrapper) or as the listener
  // itself. The raw listener each entry recorded separates a once
  // registration from an `on` registration of the same function: the removed
  // one is the entry whose raw listener is no longer on `process`.
  const live = process.rawListeners(event);
  let same = -1;
  for (let i = islandListeners.length - 1; i >= 0; i--) {
    const entry = islandListeners[i];
    if (entry.event !== event) continue;
    if (entry.listener !== listener && entry.raw !== listener) continue;
    if (entry.raw !== undefined && !live.includes(entry.raw)) {
      forget(i, kind);
      return;
    }
    if (same < 0) same = i;
  }
  // Duplicate registrations of one function share a raw listener; Node
  // removes the most recent, which is the last matching entry.
  if (same >= 0) forget(same, kind);
});

// The raw listener is the function handed to the emitter (a once wrapper
// for process.once, which registers through process.on): tag each entry
// with it as its registration returns. Node emits newListener before it
// installs the listener, so the entry learns its raw only afterwards.
function tagRaw(start, event, listener) {
  if (islandListeners.length === start) return;
  const registered = listener.listener ?? listener;
  for (let i = start; i < islandListeners.length; i++) {
    const entry = islandListeners[i];
    if (entry.event === event && entry.listener === registered && entry.raw === undefined) {
      entry.raw = listener;
      return;
    }
  }
}

// The wrappers replacing process's emitter methods, installed together by
// installProcessMethods below. One wrapper serves `on` and `addListener`,
// which are one function in Node, and each has the name of the Node function
// it wraps.
const processMethods = {};
const nodeAddListener = process.addListener;
const nodePrependListener = process.prependListener;
processMethods.on = processMethods.addListener = function addListener(event, listener) {
  const start = islandListeners.length;
  const result = Reflect.apply(nodeAddListener, this, arguments);
  tagRaw(start, event, listener);
  return result;
};
processMethods.prependListener = function prependListener(event, listener) {
  const start = islandListeners.length;
  const result = Reflect.apply(nodePrependListener, this, arguments);
  tagRaw(start, event, listener);
  return result;
};

function emit(kind, id, name, arg) {
  const entry = islandListeners.find((e) => e.id === id);
  if (entry === undefined) return;
  // The registered function: the listener itself, or its once wrapper,
  // which removes itself before calling it.
  const registered =
    entry.raw ??
    process.rawListeners(entry.event).find((raw) => (raw.listener ?? raw) === entry.listener);
  if (registered === undefined) return;
  if (kind === EVENT_SIGNAL) Reflect.apply(registered, process, [name, arg]);
  else Reflect.apply(registered, process, [arg]);
}

const nodeEmit = process.emit;
processMethods.emit = function emit(event, ...args) {
  if (event === "exit") return this.listenerCount("exit") > 0;
  return Reflect.apply(nodeEmit, this, [event, ...args]);
};

// Node's process inherits its emitter methods from EventEmitter.prototype,
// through a prototype of its own that holds only `constructor`. The wrappers
// go on that prototype with EventEmitter.prototype's attributes, so process
// has no own property for them: Object.keys(process), Object.hasOwn and
// for...in see what they see in Node. for...in lists a prototype's keys
// before its parent's, so the keys EventEmitter.prototype lists before the
// last wrapped method are defined there too, with the same values, in their
// order.
function installProcessMethods() {
  const processPrototype = Object.getPrototypeOf(process);
  const emitterPrototype = Object.getPrototypeOf(processPrototype);
  const keys = Object.keys(emitterPrototype);
  const last = Math.max(...Object.keys(processMethods).map((key) => keys.indexOf(key)));
  for (const key of keys.slice(0, last + 1)) {
    const descriptor = Object.getOwnPropertyDescriptor(emitterPrototype, key);
    if (Object.hasOwn(processMethods, key)) descriptor.value = processMethods[key];
    Object.defineProperty(processPrototype, key, descriptor);
  }
}
installProcessMethods();

// Writes reach the shared stdout and stderr before control returns to the
// program, as the program's own writes do.
for (const stream of [process.stdout, process.stderr]) {
  if (stream._handle && typeof stream._handle.setBlocking === "function")
    stream._handle.setBlocking(true);
}

// process.execPath is this program, not a node executable: a fork without
// an execPath of its own would start the program again.
const childProcess = require("node:child_process");
const nodeFork = childProcess.fork;
childProcess.fork = function fork(modulePath, args, options) {
  const forkOptions = Array.isArray(args) ? options : args;
  const execPath =
    forkOptions === null || typeof forkOptions !== "object" ? undefined : forkOptions.execPath;
  if (execPath === undefined || execPath === process.execPath) {
    throw new Error(
      "child_process.fork() in a Node island needs options.execPath (a node executable): process.execPath is this program",
    );
  }
  return Reflect.apply(nodeFork, this, arguments);
};
require("node:module").syncBuiltinESMExports();

globalThis.__scriptcNodeIsland = {
  call,
  setTimer,
  clearTimer,
  refTimer,
  refreshTimer,
  setImmediate: setImmediateJob,
  clearImmediate: clearImmediateJob,
  refImmediate,
  nextTick,
  emit,
};

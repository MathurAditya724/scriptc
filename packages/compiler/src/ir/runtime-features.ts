import type { IrClassDef, IrExpr, IrModule, IrRecordShape, IrType, IrUnionDef } from "./ir.js";
import type { IrLibFn } from "./builtin-signatures.js";
import {
  isDirentShape,
  RUNTIME_EMITTER_CLASS,
  RUNTIME_EVENT_CLASS,
  RUNTIME_EVENT_TARGET_CLASS,
  RUNTIME_STREAM_CLASSES,
} from "./ir.js";
import { everyModuleNode } from "./traverse.js";

export interface RuntimeFeatures {
  regex: boolean;
  copying: boolean;
  legacyTextDecoder: boolean;
  fileHandle: boolean;
  fetch: boolean;
  eventTarget: boolean;
  processEvents: boolean;
  emitter: boolean;
  stream: boolean;
  zlib: boolean;
  dc: boolean;
  assert: boolean;
  dynInvoke: boolean;
  dynAsync: boolean;
  /** The program enters AsyncLocalStorage stores (store.run, enterWith,
   * a diagnostics_channel store binding) or reads the test runner's
   * context (getTestContext): its timer, immediate, tick and
   * queueMicrotask scheduling goes through the runtime's *_als entry
   * points, which carry the active stores into each callback. */
  asyncContext: boolean;
  inspect: boolean;
  childProcess: boolean;
  net: boolean;
  symbol: boolean;
  bigint: boolean;
  searchParams: boolean;
  qs: boolean;
  parseArgs: boolean;
  fsWatch: boolean;
  nodeTest: boolean;
  /** The program calls mock.timers members: its timer calls go through
   * scr_test.c's mock-aware entry points. */
  mockTimers: boolean;
  dgram: boolean;
  http: boolean;
  http2: boolean;
  tls: boolean;
  tlsCa: boolean;
  cipher: boolean;
}

const DYN_ASYNC_LIB_FNS: ReadonlySet<IrLibFn> = new Set([
  // DEP0040 rides the dyn-async unit's warning machinery.
  "punycode.warn",
  "fs.callbackValue",
  "fs.callbackCall",
  "fs.callbackGlob",
  "async.awaitDyn",
  "timers.immediatePromise",
  "crypto.native",
  "dyn.promiseAll",
  "dyn.promiseAllSettled",
  "dyn.promiseAny",
  "process.onUncaughtException",
  "process.offUncaughtException",
  "process.onUnhandledRejection",
  "process.offUnhandledRejection",
  "process.onRejectionHandled",
  "process.offRejectionHandled",
  "process.onWarning",
  "process.offWarning",
  "process.emitWarning",
  "process.emitWarningText",
  "process.deprecationFlag",
  "process.setDeprecationFlag",
  // The performance timeline (scr_perf.c, linked with this unit for its
  // MaxPerformanceEntryBufferExceededWarning).
  "perf.mark",
  "perf.measure",
  "perf.entries",
  "perf.clearMarks",
  "perf.clearMeasures",
  "perf.entryName",
  "perf.entryType",
  "perf.entryStart",
  "perf.entryDuration",
  "perf.entryDetail",
  "perf.entryKeep",
  "perf.entryRef",
  // Blob and File (scr_blob.c, linked with this unit, which boxes their
  // reads as dyn promises).
  "blob.new",
  "blob.fileNew",
  "blob.slice",
  "blob.text",
  "blob.bytes",
  "blob.arrayBuffer",
  "blob.is",
  "util.styleText",
  "util.inherits",
  "util.deprecate",
  "util.callbackify",
  "util.debuglog",
  "als.new",
  "als.get",
  "als.run",
  "als.exitRun",
  "als.enterWith",
  "als.disable",
  "dc.chanBindStore",
  "dc.chanUnbindStore",
  "dc.chanRunStores",
]);

/** The libCalls that enter AsyncLocalStorage stores (RuntimeFeatures
 * asyncContext). */
const ASYNC_CONTEXT_LIB_FNS: ReadonlySet<IrLibFn> = new Set([
  "als.run",
  "als.exitRun",
  "als.enterWith",
  "dc.chanBindStore",
  "dc.chanRunStores",
  // getTestContext() reads the test runner's entry in the same snapshot.
  "test.hasContext",
  "test.context",
]);

const LEGACY_URL_LIB_FNS: ReadonlySet<IrLibFn> = new Set([
  "url.legacyParse",
  "url.legacyFormat",
  "url.legacyResolve",
  "url.domainToASCII",
  "url.domainToUnicode",
]);

const UTIL_CALLABLE_LIB_FNS: ReadonlySet<IrLibFn> = new Set([
  "util.inherits",
  "util.deprecate",
  "util.callbackify",
  "util.debuglog",
]);

/** Entry points that link the regex unit: the regex and glob matchers (fs.glob's walk compiles its patterns with the glob matcher), and readline's terminal unit (scr_readline_tty.c), which measures with the regex unit's stripVTControlCharacters. */
const REGEX_LIB_FNS: ReadonlySet<IrLibFn> = new Set([
  "dyn.nativeRegexIs",
  "fs.callbackGlob",
  "fs.globSync",
  "fs.globTypesSync",
  "fsp.globError",
  "fsp.globStrings",
  "fsp.globTypes",
  "path.matchesGlob",
  "path.win32MatchesGlob",
  "regexp.escape",
  "rl.cursorPos",
  "rl.keypressStdin",
  "rl.keypressStream",
  "stdin.onKeypress",
  "util.stripVTControlCharacters",
]);

/** TextDecoder entry points over the legacy encodings. */
const LEGACY_TEXT_DECODER_LIB_FNS: ReadonlySet<IrLibFn> = new Set([
  "text.decodeLegacy",
  "text.decodeLegacyOptions",
  "text.decodeStream",
]);

/** Signal-taking readline, stream and timers/promises entry points, which register abort listeners. */
const ABORT_SIGNAL_LIB_FNS: ReadonlySet<IrLibFn> = new Set([
  "http.clientSignal",
  "rl.createSignal",
  "rl.questionAsyncSignal",
  "sp.finishedOptsSignal",
  "sp.pipelineOptsSignal",
  "stream.addAbortSignal",
  "stream.addAbortSignalFn",
  "stream.finishedOptsSignal",
  "tp.schedulerWaitSignal",
  "tp.setImmediateSignal",
  "tp.setTimeoutSignal",
]);

/** Entry points that link the stream unit (with STREAM_LIB_PREFIXES). */
const STREAM_LIB_FNS: ReadonlySet<IrLibFn> = new Set([
  "console.bind",
  "crypto.hashStream",
  "crypto.hashStreamPiped",
  "fileHandle.createReadStream",
  "fileHandle.createWriteStream",
  "fs.createReadStream",
  "fs.createWriteStream",
  "sp.finished",
  "sp.pipeline",
  "sp.pipelineStages",
  "stream.addAbortSignal",
  "stream.addAbortSignalFn",
  "stream.destroy",
  "stream.destroyErr",
  "stream.errored",
  "stream.prop",
  "stream.workerStdio",
]);

/** libCall name prefixes that link the stream unit. */
const STREAM_LIB_PREFIXES: readonly string[] = [
  "duplex.",
  "fs.fsStream",
  "passthrough.",
  "readable.",
  "sc.",
  "sp.finishedOpts",
  "sp.pipelineOpts",
  "stream.finishedOpts",
  "stream.pipelineStages",
  "stream.set",
  "transform.",
  "writable.",
  "zlib.stream",
];

/** The Readable operators and Readable.from over a compiled generator or a checked-dynamic iterator (scr_stream_ops.c), which await through the dyn-async unit (with READABLE_DYN_ASYNC_PREFIXES). */
const READABLE_DYN_ASYNC_LIB_FNS: ReadonlySet<IrLibFn> = new Set([
  "readable.fromAsyncGen",
  "readable.fromAsyncIter",
  "readable.fromDone",
  "readable.fromDyn",
  "readable.fromIter",
]);

/** libCall name prefixes of the Readable entry points that await through the dyn-async unit. */
const READABLE_DYN_ASYNC_PREFIXES: readonly string[] = ["readable.fromGen", "readable.op"];

/** Entry points that link the dyn-invoke unit. */
const DYN_INVOKE_LIB_FNS: ReadonlySet<IrLibFn> = new Set([
  "dyn.arrayProtoCall",
  "dyn.arrayPrototype",
  "dyn.builtinFunction",
  "dyn.builtinMethod",
  "dyn.defineProperty",
  "dyn.defineProps",
  "dyn.definePrototypeProps",
  "dyn.functionApply",
  "dyn.globalConstructor",
  "dyn.objCreateWithProperties",
  "dyn.objectTag",
]);

/** Member names whose constant-key dynamic reads answer the inherited Object.prototype member through the dyn-invoke unit. Mirrors expr-dynamic.ts INHERITED_OBJECT_MEMBERS (the IR layer does not import the backend). */
const INHERITED_MEMBER_NAMES: ReadonlySet<string> = new Set([
  "constructor",
  "hasOwnProperty",
  "propertyIsEnumerable",
  "toString",
  "valueOf",
]);

/** Entry points that link the child-process unit (with CHILD_PROCESS_LIB_PREFIXES): the fork IPC channel on the process object. */
const CHILD_PROCESS_LIB_FNS: ReadonlySet<IrLibFn> = new Set([
  "process.connected",
  "process.disconnect",
  "process.forkTarget",
  "process.onDisconnect",
  "process.onMessage",
  "process.send",
  "process.sendCb",
]);

/** libCall name prefixes that link the child-process unit. */
const CHILD_PROCESS_LIB_PREFIXES: readonly string[] = ["child.", "cp.", "spawnRes.", "writer."];

/** Entry points that link the symbol unit, besides the sym. and disposable. families. */
const SYMBOL_LIB_FNS: ReadonlySet<IrLibFn> = new Set([
  "dyn.usingDispose",
  "dyn.usingMethod",
  "util.isDeepStrictEqual",
]);

/** Entry points that link the querystring unit. */
const QS_LIB_FNS: ReadonlySet<IrLibFn> = new Set(["qs.parse", "qs.stringify", "qs.unescape"]);

/** Entry points that link the parseArgs unit. */
const PARSE_ARGS_LIB_FNS: ReadonlySet<IrLibFn> = new Set([
  "util.isDeepStrictEqual",
  "util.parseArgs",
  "util.styleText",
]);

/** String methods whose Unicode tables live in the regex unit's libunicode. */
const CASE_MAPPING_STR_METHODS: ReadonlySet<string> = new Set([
  "normalize",
  "toLowerCase",
  "toUpperCase",
]);

/** Array methods that link the copying unit. */
const COPYING_ARR_METHODS: ReadonlySet<string> = new Set([
  "toReversed",
  "toSpliced",
  "with",
  "withUndefined",
]);

/** Typed-array methods that link the copying unit. */
const COPYING_BYTES_METHODS: ReadonlySet<string> = new Set([
  "join",
  "toArray",
  "toReversed",
  "with",
]);

const startsWithAny = (fn: string, prefixes: readonly string[]): boolean =>
  prefixes.some((prefix) => fn.startsWith(prefix));

/** Inspect types and expressions together in one traversal. This is a fresh
 * snapshot: callers may mutate an IR module between compilation passes. */
/** The checked-dynamic undefined value (dynUndefinedExpr). */
export function isDynUndefined(e: IrExpr): boolean {
  return e.kind === "dynFrom" && e.value.kind === "unitLit" && e.value.unit === "undefined";
}

export function moduleRuntimeFeatures(mod: IrModule): RuntimeFeatures {
  return scanRuntimeFeatures(mod);
}

/** The module's record shapes, unions and class layouts by id. */
interface TypeTables {
  records: Map<string, IrRecordShape>;
  unions: Map<string, IrUnionDef>;
  classes: Map<string, IrClassDef>;
}

/** Whether boxing a value of type `t` as dyn boxes a promise, which goes
 * through scr_async_dyn.c: a promise, a function whose result type holds
 * one, or a record, array, tuple, union, Map or Set that holds either. */
function boxesPromise(t: IrType, tables: TypeTables, seen: Set<string>): boolean {
  switch (t.kind) {
    case "promise":
      return true;
    case "func":
      // A boxed function converts its result to dyn, which boxes any promise
      // the result type holds.
      return boxesPromise(t.ret, tables, seen);
    case "array":
    case "set":
      return boxesPromise(t.elem, tables, seen);
    case "map":
      return boxesPromise(t.key, tables, seen) || boxesPromise(t.value, tables, seen);
    case "record": {
      if (seen.has(t.shapeId)) return false;
      seen.add(t.shapeId);
      const shape = tables.records.get(t.shapeId);
      return shape?.fields.some((f) => boxesPromise(f.type, tables, seen)) ?? false;
    }
    case "union": {
      if (seen.has(t.unionId)) return false;
      seen.add(t.unionId);
      const def = tables.unions.get(t.unionId);
      return def?.arms.some((a) => boxesPromise(a, tables, seen)) ?? false;
    }
    case "object": {
      // A boxed class instance exposes its fields as dyn values (Object.keys,
      // spread, inspection), boxing a promise any field holds.
      const key = `class:${t.className}`;
      if (seen.has(key)) return false;
      seen.add(key);
      const def = tables.classes.get(t.className);
      return def?.fields.some((f) => boxesPromise(f.type, tables, seen)) ?? false;
    }
    default:
      return false;
  }
}

function scanRuntimeFeatures(mod: IrModule, stopAt?: keyof RuntimeFeatures): RuntimeFeatures {
  const features: RuntimeFeatures = {
    regex: false,
    copying: false,
    legacyTextDecoder: false,
    fileHandle: false,
    fetch: false,
    // Subclasses of the runtime EventTarget/Event bases tear down and box
    // through the EventTarget unit even when no event.* libCall survives.
    eventTarget: (mod.classes ?? []).some(
      (c) => c.name === RUNTIME_EVENT_TARGET_CLASS || c.name === RUNTIME_EVENT_CLASS,
    ),
    processEvents: false,
    emitter:
      mod.workers === true || (mod.classes ?? []).some((c) => c.name === RUNTIME_EMITTER_CLASS),
    stream: (mod.classes ?? []).some((c) => RUNTIME_STREAM_CLASSES.has(c.name)),
    zlib: false,
    dc: false,
    assert: false,
    dynInvoke: mod.workers === true,
    dynAsync:
      mod.workers === true ||
      mod.functions.some(
        (fn) => fn.async === true && fn.generator === undefined && fn.returnType.kind === "dyn",
      ),
    asyncContext: false,
    inspect: false,
    childProcess: false,
    net: false,
    // A Dirent row converted to dyn carries Node's Symbol(type) key
    // (scr_dyn_dirent_finish, defined in scr_symbol.c).
    symbol: (mod.records ?? []).some(isDirentShape),
    bigint: false,
    searchParams: false,
    qs: false,
    parseArgs: false,
    fsWatch: false,
    nodeTest: false,
    mockTimers: false,
    dgram: false,
    http: false,
    http2: false,
    tls: false,
    tlsCa: false,
    cipher: false,
  };
  const keepGoing = (): boolean => stopAt === undefined || !features[stopAt];
  let tables: TypeTables | undefined;
  const typeTables = (): TypeTables =>
    (tables ??= {
      records: new Map((mod.records ?? []).map((r) => [r.id, r])),
      unions: new Map((mod.unions ?? []).map((u) => [u.id, u])),
      classes: new Map((mod.classes ?? []).map((c) => [c.name, c])),
    });
  const expr = (node: IrExpr): boolean => {
    if (node.kind === "libCall") {
      const fn = node.fn;
      if (REGEX_LIB_FNS.has(fn)) features.regex = true;
      if (LEGACY_TEXT_DECODER_LIB_FNS.has(fn)) features.legacyTextDecoder = true;
      if (fn.startsWith("fetch.")) features.fetch = true;
      if (fn.startsWith("event.") || fn === "events.addAbortListener") features.eventTarget = true;
      if (ABORT_SIGNAL_LIB_FNS.has(fn)) features.eventTarget = true;
      if (PROCESS_EVENT_LIB_FNS.has(fn)) features.processEvents = true;
      // With a completer, readline's terminal unit prints completion errors
      // through the inspect unit.
      if (fn === "rl.terminal") {
        features.regex = true;
        if (!isDynUndefined(node.args[3]!)) features.inspect = true;
      }
      if (fn.startsWith("emitter.")) features.emitter = true;
      if (STREAM_LIB_FNS.has(fn) || startsWithAny(fn, STREAM_LIB_PREFIXES)) {
        // the stream unit emits through the emitter unit, also when the
        // program constructs no stream (a pipeline of functions)
        features.stream = true;
        features.emitter = true;
      }
      if (fn.startsWith("zlib.")) features.zlib = true;
      if (READABLE_DYN_ASYNC_LIB_FNS.has(fn) || startsWithAny(fn, READABLE_DYN_ASYNC_PREFIXES))
        features.dynAsync = true;
      if (fn.startsWith("dc.")) features.dc = true;
      if (fn.startsWith("assert.")) features.assert = true;
      if (DYN_INVOKE_LIB_FNS.has(fn)) features.dynInvoke = true;
      if (DYN_ASYNC_LIB_FNS.has(fn)) features.dynAsync = true;
      if (ASYNC_CONTEXT_LIB_FNS.has(fn)) features.asyncContext = true;
      if (
        fn.startsWith("insp.") ||
        fn.startsWith("console.") ||
        fn === "global.native" ||
        fn === "util.styleText"
      )
        features.inspect = true;
      if (CHILD_PROCESS_LIB_FNS.has(fn) || startsWithAny(fn, CHILD_PROCESS_LIB_PREFIXES))
        features.childProcess = true;
      if (fn.startsWith("net.")) features.net = true;
      if (fn.startsWith("http.")) {
        features.net = true;
        features.http = true;
      }
      if (fn.startsWith("tls.") || fn.startsWith("https.") || fn.startsWith("http2.")) {
        features.net = true;
        features.http = true;
        features.tls = true;
      }
      if (fn.startsWith("http2.") && !HTTP2_LEGACY_FNS.has(fn)) features.http2 = true;
      if (fn.startsWith("sym.") || fn.startsWith("disposable.") || SYMBOL_LIB_FNS.has(fn))
        features.symbol = true;
      if (fn === "process.hrtimeValue") features.bigint = true;
      if (fn.startsWith("bigint.")) features.bigint = true;
      if (fn.startsWith("sp.") || fn === "url.searchParams") features.searchParams = true;
      if (QS_LIB_FNS.has(fn)) features.qs = true;
      // scr_url_legacy.c lowercases and normalizes hostnames (the regex
      // unit's libunicode), parses and stringifies queries, and emits its
      // deprecation warnings through the dyn-async unit.
      if (LEGACY_URL_LIB_FNS.has(fn)) {
        features.regex = true;
        features.qs = true;
        features.dynAsync = true;
      }
      if (PARSE_ARGS_LIB_FNS.has(fn)) features.parseArgs = true;
      if (fn === "util.styleText") features.processEvents = true;
      // scr_util_callable.c: dyn wrappers over the descriptor, inspect,
      // regex (NODE_DEBUG matching) and terminal-color units.
      if (UTIL_CALLABLE_LIB_FNS.has(fn)) {
        features.parseArgs = true;
        features.inspect = true;
        features.dynInvoke = true;
        features.regex = true;
      }
      if (fn.startsWith("fs.watch") || fn.startsWith("watcher.")) features.fsWatch = true;
      // scr_test.c renders thrown strings in the failing-tests section with
      // the inspect unit's string formatting.
      if (fn.startsWith("test.")) {
        features.nodeTest = true;
        features.inspect = true;
        if (fn.startsWith("test.mockTimers") || fn.startsWith("test.ctxMockTimers")) {
          features.mockTimers = true;
        }
      }
      if (fn.startsWith("dgram.") || fn.startsWith("dns.")) features.dgram = true;
      if (fn.startsWith("tlsca.")) features.tlsCa = true;
      // scr_cipher.c over the mbedTLS archive; DEP0182 reports through the
      // process-warning unit, and unknown output encodings render through
      // the inspect unit.
      if (fn === "crypto.cipherNew") {
        features.cipher = true;
        features.dynAsync = true;
        features.inspect = true;
      }
    } else {
      switch (node.kind) {
        case "regexLit":
        case "regexIntrinsic":
          features.regex = true;
          break;
        case "strIntrinsic":
          if (CASE_MAPPING_STR_METHODS.has(node.method)) features.regex = true;
          break;
        case "arrIntrinsic":
          if (COPYING_ARR_METHODS.has(node.method)) features.copying = true;
          break;
        case "bytesIntrinsic":
          if (COPYING_BYTES_METHODS.has(node.method)) features.copying = true;
          break;
        case "dynInvoke":
          features.dynInvoke = true;
          break;
        case "dynKeyGet":
          // Constant-key reads of Object.prototype member names answer the
          // inherited member through scr_dyn_invoke.c.
          if (node.key.kind === "strLit" && INHERITED_MEMBER_NAMES.has(node.key.value))
            features.dynInvoke = true;
          break;
        case "awaitExpr":
          if (node.type.kind === "dyn") features.dynAsync = true;
          break;
        case "intrinsic":
          // Rejection reasons cross as dyn values (allSettled's records,
          // any's AggregateError list).
          if (node.name === "promise.allSettled" || node.name === "promise.any")
            features.dynAsync = true;
          break;
        case "dynFrom":
          if (!features.dynAsync && boxesPromise(node.value.type, typeTables(), new Set()))
            features.dynAsync = true;
          break;
      }
    }
    return keepGoing();
  };
  const type = (node: IrType): boolean => {
    switch (node.kind) {
      case "regex":
        features.regex = true;
        break;
      case "fileHandle":
        features.fileHandle = true;
        break;
      case "procStream":
        features.processEvents = true;
        break;
      case "child":
      case "childStream":
      case "childWriter":
      case "spawnRes":
        features.childProcess = true;
        break;
      case "netServer":
      case "netSocket":
        features.net = true;
        break;
      case "http2Session":
      case "http2Stream":
        features.net = true;
        features.http2 = true;
        break;
      case "httpReq":
      case "httpRes":
      case "httpClientReq":
        features.net = true;
        features.http = true;
        break;
      case "secureCtx":
        features.net = true;
        features.http = true;
        features.tls = true;
        break;
      case "symbol":
        features.symbol = true;
        break;
      case "bigint":
        features.bigint = true;
        break;
      case "searchParams":
        features.searchParams = true;
        break;
      case "fsWatcher":
        features.fsWatch = true;
        break;
      case "testCtx":
        features.nodeTest = true;
        break;
      case "dgramSocket":
        features.dgram = true;
        break;
    }
    return keepGoing();
  };
  if (keepGoing()) everyModuleNode(mod, { expr, stmt: keepGoing, type });
  return features;
}

/** True when the module contains any regex construct — a regexLit /
 * regexIntrinsic node or a regex-typed slot anywhere. This is the link
 * switch that pulls scr_regex.c + the vendored libregexp into the binary
 * (native-toolchain.ts); regex-free programs keep the historical command line. The
 * typed traversal visits type slots as well as executable nodes. */
export function moduleUsesRegex(mod: IrModule): boolean {
  return scanRuntimeFeatures(mod, "regex").regex;
}

/** True when the module contains an intrinsic whose implementation lives
 * in scr_copying.c. This is the link switch that keeps the optional
 * Array-copying and typed-array bridge TU out of unrelated binaries. */
export function moduleUsesCopying(mod: IrModule): boolean {
  return scanRuntimeFeatures(mod, "copying").copying;
}

/** True when a non-UTF-8 TextDecoder call survives lowering. This gates the
 * generated legacy mapping tables inside scr_bytes.c; the default UTF-8
 * decoder and unrelated Buffer users keep their prior runtime object. */
export function moduleUsesLegacyTextDecoder(mod: IrModule): boolean {
  return scanRuntimeFeatures(mod, "legacyTextDecoder").legacyTextDecoder;
}

/** True when a FileHandle type survives in the module. This is the link
 * switch for scr_file_handle.c; fs/promises.open carries the type inside its
 * promise result even when no handle method is called. */
export function moduleUsesFileHandle(mod: IrModule): boolean {
  return scanRuntimeFeatures(mod, "fileHandle").fileHandle;
}

/** True when native fetch operations survive lowering. This links
 * scr_fetch.c and its socket/tls/zlib dependencies and makes the emitted
 * main call scr_fetch_install. Fetch-free graphs keep their link lines. */
export function moduleUsesFetch(mod: IrModule): boolean {
  return scanRuntimeFeatures(mod, "fetch").fetch;
}

/** The libCall fns served by the OPTIONAL events unit (scr_events.c):
 * process signal/exit listeners and the piped-stdin surface. */
const PROCESS_EVENT_LIB_FNS: ReadonlySet<IrLibFn> = new Set([
  "process.stdio",
  "process.onSignal",
  "process.offSignal",
  "process.onExit",
  "process.offExit",
  "stdin.onData",
  "stdin.onEnd",
  "stdin.onError",
  "stdin.nextChunk",
  // node:readline rides the stdin unit (scr_readline.c links beside
  // scr_events.c under the same gate).
  "rl.create",
  "rl.createSignal",
  "rl.question",
  "rl.questionAsync",
  "rl.questionAsyncSignal",
  "rl.close",
  "rl.pause",
  "rl.resume",
  "rl.prompt",
  "rl.promptWith",
  "rl.setPrompt",
  "rl.getPrompt",
  "rl.write",
  "rl.writeKey",
  "rl.on",
  "rl.iterOpen",
  "rl.iterNext",
  "rl.iterReturn",
  "rl.checkOptions",
  "rl.checkCompleter",
  "rl.setOptions",
  "rl.setHistory",
  "rl.history",
  "rl.numProp",
  "rl.terminal",
  "rl.line",
  "rl.isTerminal",
  "rl.cursor",
  "rl.seq",
  "rl.moves",
  "rl.cursorPos",
  "rl.keypressStdin",
  "rl.keypressStream",
  "stdin.onKeypress",
  "rl.uiOpen",
  "rl.uiOpenStream",
  "rl.uiCursorTo",
  "rl.uiMoveCursor",
  "rl.uiClearLine",
  "rl.uiClearScreenDown",
  "rl.uiRollback",
  "rl.uiCommit",
]);

/** True when the module uses the process-events surface — the link switch
 * that pulls scr_events.c into the binary and has the emitted main call
 * scr_events_install (native-toolchain.ts + emitter; the scr_regex/scr_fetch/scr_zlib
 * gating precedent). Event-free programs pay zero bytes and keep their
 * exact link line. Same generic-walk shape as moduleUsesRegex. */
export function moduleUsesProcessEvents(mod: IrModule): boolean {
  return scanRuntimeFeatures(mod, "processEvents").processEvents;
}

/** True when the module uses the node:events EventEmitter surface — the
 * link switch that pulls scr_events_emitter.c into the binary (native-toolchain.ts; the
 * scr_events.c gating precedent, but pure data structure: no install, no
 * loop hooks). Two signals: the `%EventEmitter` class def rides the
 * module (any emitter-typed value or `extends EventEmitter` subclass
 * references it, and the emitted RC/trace helpers call scr_emitter_*),
 * or an emitter.* libCall survived (the defaultMaxListeners statics carry
 * no emitter-typed value). Emitter-free programs pay zero bytes and keep
 * their exact link line. */
export function moduleUsesEmitter(mod: IrModule): boolean {
  return scanRuntimeFeatures(mod, "emitter").emitter;
}

/** True when the program touches the node:stream surface (scr_stream.c —
 * the moduleUsesEmitter story: the class defs ride the module whenever a
 * stream-typed value exists, and every stream libCall names its unit).
 * Stream programs always use the emitter unit too — the stream class
 * defs pull `%EventEmitter` through their base chain, so
 * moduleUsesEmitter answers true whenever this does. Stream-free
 * programs pay zero bytes and keep their exact link line. */
export function moduleUsesStream(mod: IrModule): boolean {
  return scanRuntimeFeatures(mod, "stream").stream;
}

export const NPM_COMPRESS_MIN = 1024;

export function moduleUsesZlib(mod: IrModule): boolean {
  return scanRuntimeFeatures(mod, "zlib").zlib;
}

/** True when the module contains any dc.* libCall — the link switch that
 * pulls scr_dc.c (the diagnostics_channel registry and pub/sub) into the
 * binary (native-toolchain.ts). Channel-free binaries keep their exact size class.
 * Same walk shape as moduleUsesZlib. */
export function moduleUsesDc(mod: IrModule): boolean {
  return scanRuntimeFeatures(mod, "dc").dc;
}

/** True when the module contains any assert libCall — the link switch
 * that pulls scr_assert.c into the binary (native-toolchain.ts). scr_regex.c calls the
 * assert throw/inspect helpers (assert.match lives there), so the regex
 * switch also pulls scr_assert.c; assert-free, regex-free binaries keep
 * the historical command line and size. Same walk shape as
 * moduleUsesZlib. */
export function moduleUsesAssert(mod: IrModule): boolean {
  return scanRuntimeFeatures(mod, "assert").assert;
}

/** True when the module contains any dynInvoke node or dyn.defineProps
 * libCall — the link switch that pulls scr_dyn_invoke.c (the prototype-
 * method dispatch on dyn receivers, plus scr_dyn_display and
 * scr_dyn_define_props) into the binary (native-toolchain.ts; the assert gating
 * precedent — dispatch-free binaries keep their exact size class). Same
 * walk shape as moduleUsesZlib. */
export function moduleUsesDynInvoke(mod: IrModule): boolean {
  return scanRuntimeFeatures(mod, "dynInvoke").dynInvoke;
}

/** True when the module contains any insp libCall — the link switch that
 * pulls scr_inspect.c into the binary (native-toolchain.ts; the assert gating
 * precedent — inspect-free binaries keep the historical command line and
 * size class). Same walk shape as moduleUsesZlib. */
/** True when the module needs scr_async_dyn.c — the checked-dynamic
 * async surfaces (dyn-promise then/catch/finally reactions, await of a
 * dyn value, `new Promise(setImmediate)`, AsyncLocalStorage, the
 * unhandledRejection/warning process events). Also pulled by the
 * dynInvoke and dc gates (their TUs call into this one) — native-toolchain.ts. Same
 * walk shape as moduleUsesZlib. */
export function moduleUsesDynAsync(mod: IrModule): boolean {
  return scanRuntimeFeatures(mod, "dynAsync").dynAsync;
}

export function moduleUsesInspect(mod: IrModule): boolean {
  return scanRuntimeFeatures(mod, "inspect").inspect;
}

/** True when the module reaches child_process or carries one of its runtime
 * handle/result types. Besides the existing link consequence, this gates the
 * checked-dynamic ChildProcess handle table installed from scr_child.c. */
export function moduleUsesChildProcess(mod: IrModule): boolean {
  return scanRuntimeFeatures(mod, "childProcess").childProcess;
}

/** True when the module contains any net libCall — the link switch that
 * pulls scr_net.c into the binary and has the emitted main call
 * scr_net_install (native-toolchain.ts + emitter; the scr_events gating precedent).
 * Net-free programs pay zero bytes and keep their exact link line. Same
 * generic-walk shape as moduleUsesZlib. */
export function moduleUsesNet(mod: IrModule): boolean {
  return scanRuntimeFeatures(mod, "net").net;
}

/** True when the module contains any sym.* libCall or a symbol-kind type
 * anywhere in the IR — the link switch that pulls scr_symbol.c into the
 * binary (native-toolchain.ts; the scr_net gating precedent — no install call, the
 * Symbol.for registry initializes lazily). The TYPE check matters like
 * net's: a symbol-typed local whose initializer compiled to a runtime
 * fence still emits release calls that need the unit linked. Symbol-free
 * programs pay zero bytes and keep their exact link line. */
export function moduleUsesSymbol(mod: IrModule): boolean {
  return scanRuntimeFeatures(mod, "symbol").symbol;
}

/** True when bigint runtime operations or bigint-typed storage appears in
 * the IR. The type check keeps retain/release references link-safe even
 * when a producing statement was replaced by a runtime fence. */
export function moduleUsesBigInt(mod: IrModule): boolean {
  return scanRuntimeFeatures(mod, "bigint").bigint;
}

/** True when the module uses the URLSearchParams surface — sp.* libCalls,
 * the url.searchParams getter, or a searchParams-kind type anywhere on
 * the IR (a fenced statement can leave a typed local whose release call
 * still needs the unit linked) — the link switch that pulls
 * scr_url_params.c into the binary (the moduleUsesSymbol precedent: pure
 * data structure, no loop hooks, cross-compiles everywhere). sp-free
 * programs keep their exact link line; scr_url.c itself stays
 * always-linked and never references the unit. */
export function moduleUsesSearchParams(mod: IrModule): boolean {
  return scanRuntimeFeatures(mod, "searchParams").searchParams;
}

/** True when the module uses the node:querystring surface — the qs.*
 * libCalls that live in scr_qs.c (parse/stringify/unescape; qs.escape
 * emits the always-linked component encoder and deliberately does NOT
 * flip this switch) — the link switch that pulls scr_qs.c into the
 * binary (the moduleUsesSearchParams precedent: pure data transforms, no
 * loop hooks, cross-compiles everywhere). qs-free programs keep their
 * exact link line. Same generic-walk shape as moduleUsesZlib. */
export function moduleUsesQs(mod: IrModule): boolean {
  return scanRuntimeFeatures(mod, "qs").qs;
}

export function moduleUsesParseArgs(mod: IrModule): boolean {
  return scanRuntimeFeatures(mod, "parseArgs").parseArgs;
}

/** True when the module contains any fs.watch/watcher.* libCall — the
 * link switch that pulls scr_watch.c into the binary and has the emitted
 * main call scr_watch_install (native-toolchain.ts + emitter; the scr_net gating
 * precedent). Watch-free programs pay zero bytes and keep their exact
 * link line. Same generic-walk shape as moduleUsesZlib. */
export function moduleUsesFsWatch(mod: IrModule): boolean {
  return scanRuntimeFeatures(mod, "fsWatch").fsWatch;
}

/** True when the module contains any test.* libCall or a testCtx handle
 * type — the link switch that pulls scr_test.c into the binary and has
 * the emitted main return scr_test_exit_code() after the loop drains
 * (native-toolchain.ts + emitter; the moduleUsesDgram shape). Test-free programs pay
 * zero bytes and keep their exact link line. */
export function moduleUsesNodeTest(mod: IrModule): boolean {
  return scanRuntimeFeatures(mod, "nodeTest").nodeTest;
}

/** True when the module calls a mock.timers member (a test.mockTimers* or
 * test.ctxMockTimers* libCall). The emitter then routes the timer calls
 * through scr_test.c's mock-aware entry points; other programs keep the
 * loop's timer functions. */
export function moduleUsesMockTimers(mod: IrModule): boolean {
  return scanRuntimeFeatures(mod, "mockTimers").mockTimers;
}

/** True when the module contains any dgram.* or dns.* libCall — the
 * link switch that pulls scr_dgram.c into the binary and has the emitted
 * main call scr_dgram_install (native-toolchain.ts + emitter; the scr_net gating
 * precedent — dns.lookup lives in the same unit, so either prefix
 * answers). Dgram-free programs pay zero bytes and keep their exact link
 * line. Same generic-walk shape as moduleUsesZlib. */
export function moduleUsesDgram(mod: IrModule): boolean {
  return scanRuntimeFeatures(mod, "dgram").dgram;
}

/** True when the module contains any http.* libCall — the link switch
 * that pulls scr_http.c into the binary (native-toolchain.ts; moduleUsesNet already
 * answers true for these, so scr_net.c comes along). */
export function moduleUsesHttpServer(mod: IrModule): boolean {
  return scanRuntimeFeatures(mod, "http").http;
}

/** The legacy http2.* libCalls implemented by scr_http.c/scr_tls.c (the
 * allowHTTP1 compatibility slice) — they must NOT pull scr_http2.c, so
 * divergence-57 binaries keep their exact link line. */
const HTTP2_LEGACY_FNS: ReadonlySet<IrLibFn> = new Set([
  "http2.streamNoop",
  "http2.streamUndefCall",
]);

/** True when the module uses the REAL h2 surface (scr_http2.c): any core
 * http2.* libCall, or an h2 handle type left behind by a fenced statement
 * (its emitted release call needs the unit — the moduleUsesNet story). */
export function moduleUsesHttp2(mod: IrModule): boolean {
  return scanRuntimeFeatures(mod, "http2").http2;
}

/** True when the module contains any tls.* or https.* libCall — the link
 * switch that pulls scr_tls.c and the vendored mbedTLS archive into the
 * binary (native-toolchain.ts; moduleUsesNet and moduleUsesHttpServer already answer
 * true for these, so scr_net.c and scr_http.c come along). TLS-free
 * programs keep their exact link line and never build mbedTLS. */
export function moduleUsesTls(mod: IrModule): boolean {
  return scanRuntimeFeatures(mod, "tls").tls;
}

/** True when the module contains any tlsca.* libCall — the link switch
 * for scr_tls_ca.c, the CA-store introspection unit (getCACertificates /
 * rootCertificates / setDefaultCACertificates). Deliberately SEPARATE
 * from moduleUsesTls: the unit is plain PEM-block bookkeeping, so a
 * program that only inspects the CA store never pulls mbedTLS. native-toolchain.ts
 * also compiles the unit whenever TLS itself links — scr_tls.c consults
 * the unit's default-set override for its trust anchors. */
export function moduleUsesTlsCa(mod: IrModule): boolean {
  return scanRuntimeFeatures(mod, "tlsCa").tlsCa;
}

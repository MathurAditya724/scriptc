/// <reference path="./child_process.d.ts" />
/// <reference path="./crypto.d.ts" />
/// <reference path="./dns.d.ts" />
/// <reference path="./fs.d.ts" />
/// <reference path="./stream.d.ts" />
/// <reference path="./stream-promises.d.ts" />
/// <reference path="./timers-promises.d.ts" />
/// <reference path="./util-types.d.ts" />
/// <reference path="./zlib.d.ts" />

/* node:util — compile-time projections for child_process.execFile,
 * child_process.exec and fs.readFile. The first two retain Node's custom
 * { stdout, stderr } result; the last resolves the callback's data
 * argument. Other targets and bare
 * promisify values fence per site. */
declare module "util" {
  export * as types from "util/types";
  export function getSystemErrorName(err: number): string;
  export function getSystemErrorMessage(err: number): string;
  export function getSystemErrorMap(): Map<number, [string, string]>;
  export function stripVTControlCharacters(str: string): string;
  export function toUSVString(string: string): string;
  export function isDeepStrictEqual(val1: unknown, val2: unknown, skipPrototype?: boolean): boolean;
  export function styleText(
    format: string | readonly string[],
    text: string,
    options?: { validateStream?: boolean; stream?: unknown },
  ): string;
  export function parseEnv(content: string): { [key: string]: string | undefined };
  export function inherits(constructor: unknown, superConstructor: unknown): void;
  export interface DeprecateOptions {
    modifyPrototype?: boolean;
  }
  export function deprecate<T extends Function>(
    fn: T,
    msg: string,
    code?: string,
    options?: DeprecateOptions,
  ): T;
  /* The callback receives null on success and the rejection reason
   * otherwise (falsy reasons arrive as ERR_FALSY_VALUE_REJECTION). */
  export function callbackify(
    fn: () => Promise<void>,
  ): (callback: (err: NodeJS.ErrnoException | null) => void) => void;
  export function callbackify<TResult>(
    fn: () => Promise<TResult>,
  ): (callback: (err: NodeJS.ErrnoException | null, result: TResult) => void) => void;
  export function callbackify<T1>(
    fn: (arg1: T1) => Promise<void>,
  ): (arg1: T1, callback: (err: NodeJS.ErrnoException | null) => void) => void;
  export function callbackify<T1, TResult>(
    fn: (arg1: T1) => Promise<TResult>,
  ): (arg1: T1, callback: (err: NodeJS.ErrnoException | null, result: TResult) => void) => void;
  export function callbackify<T1, T2>(
    fn: (arg1: T1, arg2: T2) => Promise<void>,
  ): (arg1: T1, arg2: T2, callback: (err: NodeJS.ErrnoException | null) => void) => void;
  export function callbackify<T1, T2, TResult>(
    fn: (arg1: T1, arg2: T2) => Promise<TResult>,
  ): (
    arg1: T1,
    arg2: T2,
    callback: (err: NodeJS.ErrnoException | null, result: TResult) => void,
  ) => void;
  export function callbackify<T1, T2, T3>(
    fn: (arg1: T1, arg2: T2, arg3: T3) => Promise<void>,
  ): (arg1: T1, arg2: T2, arg3: T3, callback: (err: NodeJS.ErrnoException | null) => void) => void;
  export function callbackify<T1, T2, T3, TResult>(
    fn: (arg1: T1, arg2: T2, arg3: T3) => Promise<TResult>,
  ): (
    arg1: T1,
    arg2: T2,
    arg3: T3,
    callback: (err: NodeJS.ErrnoException | null, result: TResult) => void,
  ) => void;
  export type DebugLoggerFunction = (msg: string, ...param: unknown[]) => void;
  export interface DebugLogger extends DebugLoggerFunction {
    enabled: boolean;
  }
  export function debuglog(
    section: string,
    callback?: (fn: DebugLoggerFunction) => void,
  ): DebugLogger;
  export { debuglog as debug };
  export type TextEncoder = globalThis.TextEncoder;
  export type TextDecoder = globalThis.TextDecoder;
  export var TextEncoder: typeof globalThis.TextEncoder;
  export var TextDecoder: typeof globalThis.TextDecoder;
  /* stream.pipeline's overload comes first: its __promisify__ member keeps
   * every other target out of it. */
  export function promisify(
    fn: typeof import("node:stream").pipeline,
  ): typeof import("node:stream/promises").pipeline;
  export function promisify(
    fn: typeof import("node:fs").readFile,
  ): (path: string, encoding: "utf8" | "utf-8") => Promise<string>;
  export function promisify(
    fn: (file: string, args?: string[] | null, options?: object) => unknown,
  ): (
    file: string,
    args?: string[],
    options?: {
      encoding?: "utf8" | "utf-8";
      cwd?: string;
      env?: { [k: string]: string | undefined };
      timeout?: number;
      maxBuffer?: number;
      killSignal?: string;
      windowsHide?: boolean;
    },
  ) => Promise<{ stdout: string; stderr: string }>;
  export function promisify(
    fn: typeof globalThis.setTimeout,
  ): typeof import("node:timers/promises").setTimeout;
  export function promisify(
    fn: typeof globalThis.setImmediate,
  ): typeof import("node:timers/promises").setImmediate;
  export function promisify(fn: typeof import("node:child_process").exec): (
    command: string,
    options?: {
      encoding?: "utf8" | "utf-8";
      cwd?: string;
      env?: { [k: string]: string | undefined };
      timeout?: number;
      maxBuffer?: number;
      killSignal?: string;
      windowsHide?: boolean;
    },
  ) => Promise<{ stdout: string; stderr: string }>;
  /* The zlib callback one-shots (deflate, inflate, deflateRaw, inflateRaw,
   * gzip, gunzip, unzip) share one type. */
  export function promisify(
    fn: typeof import("node:zlib").gzip,
  ): (data: string | Uint8Array, options?: import("node:zlib").ZlibOptions) => Promise<Buffer>;
  export function promisify(
    fn: typeof import("node:stream").finished,
  ): typeof import("node:stream/promises").finished;
  /* The crypto callback functions: the promise settles with the callback's
   * value. */
  export function promisify(
    fn: typeof import("node:crypto").randomBytes,
  ): (size: number) => Promise<Buffer>;
  export function promisify(
    fn: typeof import("node:crypto").pbkdf2,
  ): (
    password: string | Uint8Array,
    salt: string | Uint8Array,
    iterations: number,
    keylen: number,
    digest: string,
  ) => Promise<Buffer>;
  export function promisify(
    fn: typeof import("node:crypto").scrypt,
  ): (
    password: import("node:crypto").BinaryLike,
    salt: import("node:crypto").BinaryLike,
    keylen: number,
    options?: import("node:crypto").ScryptOptions,
  ) => Promise<Buffer>;
  export function promisify(
    fn: typeof import("node:crypto").hkdf,
  ): (
    digest: string,
    ikm: import("node:crypto").BinaryLike | import("node:crypto").KeyObject,
    salt: import("node:crypto").BinaryLike,
    info: import("node:crypto").BinaryLike,
    keylen: number,
  ) => Promise<ArrayBuffer>;
  /* A callback-only function (`obj.close.bind(obj)`): before the targets
   * whose leading parameters would otherwise capture it. Builtins that take
   * arguments before their callback never match these. */
  export function promisify<TResult>(
    fn: (callback: (err: any, result: TResult) => void) => void,
  ): () => Promise<TResult>;
  export function promisify(fn: (callback: (err?: any) => void) => void): () => Promise<void>;
  export function promisify(
    fn: typeof import("node:crypto").randomFill,
  ): <T extends ArrayBufferView | ArrayBufferLike>(
    buffer: T,
    offset?: number,
    size?: number,
  ) => Promise<T>;
  export function promisify(fn: typeof import("node:crypto").randomInt): {
    (max: number): Promise<number>;
    (min: number, max: number): Promise<number>;
  };
  export function promisify(
    fn: typeof import("node:crypto").generateKey,
  ): (
    type: "hmac" | "aes",
    options: { length: number },
  ) => Promise<import("node:crypto").KeyObject>;
  /* dns.lookup's promise settles with { address, family } (the address
   * array with options.all), and lookupService's with { hostname, service }. */
  export function promisify(fn: typeof import("node:dns").lookup): {
    (
      hostname: string,
      options: import("node:dns").LookupAllOptions,
    ): Promise<import("node:dns").LookupAddress[]>;
    (
      hostname: string,
      options?: number | import("node:dns").LookupOneOptions,
    ): Promise<import("node:dns").LookupAddress>;
  };
  export function promisify(
    fn: typeof import("node:dns").lookupService,
  ): (address: string, port: number) => Promise<{ hostname: string; service: string }>;
  /* Declared surface without full lowering (the type-level tolerance
   * story: guarded/diagnostic-path code must TYPECHECK; a reached use
   * without a lowering fences at its site). inspect's options carry the
   * documented knobs through an index signature. */
  export function inspect(
    object: unknown,
    options?: { depth?: number | null; colors?: boolean; [k: string]: unknown },
  ): string;
  export function format(format?: unknown, ...args: unknown[]): string;
  export function formatWithOptions(
    inspectOptions: { depth?: number | null; colors?: boolean; [k: string]: unknown },
    format?: unknown,
    ...args: unknown[]
  ): string;
  export type ParseArgsOptionsType = "boolean" | "string";
  export interface ParseArgsOptionDescriptor {
    type: ParseArgsOptionsType;
    multiple?: boolean;
    short?: string;
    default?: string | boolean | string[] | boolean[];
  }
  export interface ParseArgsOptionsConfig {
    [longOption: string]: ParseArgsOptionDescriptor;
  }
  export interface ParseArgsConfig {
    args?: readonly string[];
    options?: ParseArgsOptionsConfig;
    strict?: boolean;
    allowPositionals?: boolean;
    allowNegative?: boolean;
    tokens?: boolean;
  }
  export type ParseArgsToken =
    | {
        kind: "option";
        index: number;
        name: string;
        rawName: string;
        value: string | undefined;
        inlineValue: boolean | undefined;
      }
    | { kind: "positional"; index: number; value: string }
    | { kind: "option-terminator"; index: number };
  export interface ParseArgsResult {
    values: { [longOption: string]: undefined | string | boolean | Array<string | boolean> };
    positionals: string[];
    tokens?: ParseArgsToken[];
  }
  export function parseArgs(config?: ParseArgsConfig): ParseArgsResult;
  /* util.getCallSites (Node ≥22.9): the captured-frame slice harness
   * code reads. No stack bookkeeping exists in a compiled binary — every
   * reached call fences per site. */
  export interface CallSite {
    readonly functionName: string;
    readonly scriptName: string;
    readonly lineNumber: number;
    readonly column: number;
  }
  export function getCallSites(frameCount?: number): CallSite[];
}

declare module "node:util" {
  export * from "util";
}

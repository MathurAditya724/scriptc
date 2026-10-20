// undici's fetch(). Without a dispatcher (no init.dispatcher and no
// program-installed global dispatcher) it is the runtime's own fetch, which
// implements the same WHATWG algorithm. With one, the request goes through
// that dispatcher (its connector, lookup and pool), following undici's
// fetch for request headers, redirects and errors; the response body is
// buffered into a native Response.
//
// Known gaps: a Response built here reports `url` as "" and `redirected` as
// false (the runtime's Response has no settable URL yet), and https requests
// offer `gzip, deflate` rather than undici's `br, gzip, deflate` (the runtime
// has no Brotli decoder).
import { gunzipSync, inflateSync } from "node:zlib";
import type { Dispatcher } from "./dispatcher.ts";
import { getGlobalDispatcher, hasCustomGlobalDispatcher } from "./api.ts";
import type { DispatchHandlers, Profile } from "./types.ts";

/** undici's RequestInit, restricted to the implemented members: string and
 * byte bodies, and the init members the dispatcher path honors. */
export interface UndiciRequestInit {
  method?: string;
  headers?: Headers | [string, string][] | Record<string, string>;
  body?: string | Uint8Array | null;
  signal?: AbortSignal | null;
  redirect?: "follow" | "manual" | "error";
  dispatcher?: Dispatcher;
}

/** The fetch standard's blocked ports (undici lib/web/fetch/constants.js). */
const badPorts = new Set([
  "1",
  "7",
  "9",
  "11",
  "13",
  "15",
  "17",
  "19",
  "20",
  "21",
  "22",
  "23",
  "25",
  "37",
  "42",
  "43",
  "53",
  "69",
  "77",
  "79",
  "87",
  "95",
  "101",
  "102",
  "103",
  "104",
  "109",
  "110",
  "111",
  "113",
  "115",
  "117",
  "119",
  "123",
  "135",
  "137",
  "139",
  "143",
  "161",
  "179",
  "389",
  "427",
  "465",
  "512",
  "513",
  "514",
  "515",
  "526",
  "530",
  "531",
  "532",
  "540",
  "548",
  "554",
  "556",
  "563",
  "587",
  "601",
  "636",
  "989",
  "990",
  "993",
  "995",
  "1719",
  "1720",
  "1723",
  "2049",
  "3659",
  "4045",
  "4190",
  "5060",
  "5061",
  "6000",
  "6566",
  "6665",
  "6666",
  "6667",
  "6668",
  "6669",
  "6679",
  "6697",
  "10080",
]);

interface RawResponse {
  status: number;
  statusText: string;
  headers: string[];
  body: Buffer;
}

const redirectStatuses = [301, 302, 303, 307, 308];
const nullBodyStatuses = [101, 204, 205, 304];

export function undiciFetch(
  input: string | URL,
  init: UndiciRequestInit | undefined,
  createGlobal: () => Dispatcher,
  _profile: Profile,
): Promise<Response> {
  const explicit = init !== undefined ? init.dispatcher : undefined;
  if (explicit === undefined && !hasCustomGlobalDispatcher()) {
    if (init === undefined) return fetch(input);
    return fetch(input, {
      method: init.method,
      headers: init.headers,
      body: init.body,
      signal: init.signal ?? undefined,
      redirect: init.redirect,
    });
  }
  const dispatcher = explicit ?? getGlobalDispatcher(createGlobal);
  return fetchThrough(dispatcher, input, init ?? {});
}

function normalizeMethod(method: string): string {
  const upper = method.toUpperCase();
  return ["DELETE", "GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH"].includes(upper)
    ? upper
    : method;
}

async function fetchThrough(
  dispatcher: Dispatcher,
  input: string | URL,
  init: UndiciRequestInit,
): Promise<Response> {
  let url = typeof input === "string" ? new URL(input) : new URL(input.href);
  let method = normalizeMethod(init.method ?? "GET");
  const signal = init.signal ?? null;
  const redirectMode = init.redirect ?? "follow";

  // Request headers: the caller's (as a Headers list: lower-cased, sorted,
  // combined), then undici fetch's defaults.
  const headers = headerListOf(init.headers);
  let body: Buffer | null = null;
  const rawBody = init.body ?? null;
  if (rawBody !== null) {
    if (typeof rawBody === "string") {
      body = Buffer.from(rawBody);
      if (!headers.has("content-type")) headers.set("content-type", "text/plain;charset=UTF-8");
    } else {
      body = Buffer.from(rawBody.buffer, rawBody.byteOffset, rawBody.byteLength);
    }
  }
  if (!headers.has("accept")) headers.set("accept", "*/*");
  if (!headers.has("accept-language")) headers.set("accept-language", "*");

  for (let redirects = 0; ; redirects++) {
    if (signal !== null && signal.aborted) throw abortReason(signal);
    if (badPorts.has(url.port)) {
      throw new TypeError("fetch failed", { cause: new Error("bad port") });
    }
    const requestHeaders = new HeaderList(headers);
    if (body !== null) {
      if (!requestHeaders.has("content-length"))
        requestHeaders.set("content-length", String(body.length));
    } else if ((method === "POST" || method === "PUT") && !requestHeaders.has("content-length")) {
      requestHeaders.set("content-length", "0");
    }
    requestHeaders.set("sec-fetch-mode", "cors");
    if (!requestHeaders.has("user-agent")) requestHeaders.set("user-agent", "undici");
    // undici also offers br over https; the native runtime has no Brotli
    // decoder, so only the codings it can decode are offered.
    if (!requestHeaders.has("accept-encoding"))
      requestHeaders.set("accept-encoding", "gzip, deflate");
    const pairs = requestHeaders.pairs();

    let raw: RawResponse;
    try {
      raw = await dispatchOnce(dispatcher, url, method, pairs, body, signal);
    } catch (err) {
      if (signal !== null && signal.aborted) throw abortReason(signal);
      throw new TypeError("fetch failed", { cause: err });
    }

    const responseHeaders = new Headers();
    for (let i = 0; i + 1 < raw.headers.length; i += 2) {
      responseHeaders.append(raw.headers[i]!, raw.headers[i + 1]!);
    }
    const location = responseHeaders.get("location");
    if (redirectStatuses.includes(raw.status) && location !== null && redirectMode !== "manual") {
      if (redirectMode === "error") {
        throw new TypeError("fetch failed", { cause: new Error("unexpected redirect") });
      }
      if (redirects >= 20) {
        throw new TypeError("fetch failed", { cause: new Error("redirect count exceeded") });
      }
      const next = new URL(location, url);
      if (
        raw.status === 303 && method !== "GET" && method !== "HEAD"
          ? true
          : (raw.status === 301 || raw.status === 302) && method === "POST"
      ) {
        method = "GET";
        body = null;
        for (const name of [
          "content-encoding",
          "content-language",
          "content-location",
          "content-type",
          "content-length",
        ]) {
          headers.delete(name);
        }
      }
      if (next.origin !== url.origin) {
        headers.delete("authorization");
        headers.delete("proxy-authorization");
        headers.delete("cookie");
        headers.delete("host");
      }
      url = next;
      continue;
    }

    const nullBody = nullBodyStatuses.includes(raw.status) || method === "HEAD";
    return new Response(
      nullBody ? null : decode(raw.body, responseHeaders.get("content-encoding")),
      {
        status: raw.status,
        statusText: raw.statusText,
        headers: responseHeaders,
      },
    );
  }
}

/** A Fetch header list: lower-cased names, values combined with ", " in
 * insertion order, serialized sorted by name (set-cookie values stay
 * separate) — what a Headers object yields when iterated. */
class HeaderList {
  names: string[];
  values: Map<string, string[]>;

  constructor(from: HeaderList | null) {
    this.names = from !== null ? from.names.slice() : [];
    this.values = new Map<string, string[]>();
    if (from !== null)
      for (const name of from.names) this.values.set(name, from.values.get(name)!.slice());
  }

  has(name: string): boolean {
    return this.values.has(name.toLowerCase());
  }

  append(name: string, value: string): void {
    const key = name.toLowerCase();
    const normalized = value.replace(/^[\t\n\r ]+|[\t\n\r ]+$/g, "");
    const existing = this.values.get(key);
    if (existing !== undefined) existing.push(normalized);
    else {
      this.names.push(key);
      this.values.set(key, [normalized]);
    }
  }

  set(name: string, value: string): void {
    this.delete(name);
    this.append(name, value);
  }

  delete(name: string): void {
    const key = name.toLowerCase();
    if (!this.values.has(key)) return;
    this.values.delete(key);
    this.names = this.names.filter((n) => n !== key);
  }

  pairs(): string[] {
    const out: string[] = [];
    for (const name of this.names.slice().sort()) {
      const list = this.values.get(name)!;
      if (name === "set-cookie") for (const value of list) out.push(name, value);
      else out.push(name, list.join(", "));
    }
    return out;
  }
}

/** The caller's headers init as a header list. Records and pair arrays read
 * directly; a Headers object is read through forEach. */
function headerListOf(
  init: Headers | [string, string][] | Record<string, string> | undefined,
): HeaderList {
  const list = new HeaderList(null);
  if (init === undefined) return list;
  if (init instanceof Headers) {
    init.forEach((value: string, name: string) => list.append(name, value));
  } else if (Array.isArray(init)) {
    for (const pair of init) list.append(pair[0], pair[1]);
  } else {
    for (const name of Object.keys(init)) list.append(name, init[name]!);
  }
  return list;
}

function decode(body: Buffer, encoding: string | null): Buffer {
  if (encoding === null || body.length === 0) return body;
  let out = body;
  const codings = encoding
    .toLowerCase()
    .split(",")
    .map((c) => c.trim())
    .reverse();
  for (const coding of codings) {
    if (coding === "gzip" || coding === "x-gzip") out = gunzipSync(out);
    else if (coding === "deflate") out = inflateSync(out);
    else return body;
  }
  return out;
}

function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error
    ? reason
    : new DOMException("This operation was aborted", "AbortError");
}

function dispatchOnce(
  dispatcher: Dispatcher,
  url: URL,
  method: string,
  headers: string[],
  body: Buffer | null,
  signal: AbortSignal | null,
): Promise<RawResponse> {
  return new Promise<RawResponse>((resolve, reject) => {
    let status = 0;
    let statusText = "";
    let rawHeaders: string[] = [];
    const chunks: Buffer[] = [];
    let settled = false;
    let abortFn: ((err?: Error) => void) | null = null;
    const onAbort = (): void => {
      const abort = abortFn;
      if (abort !== null && signal !== null) abort(abortReason(signal));
    };
    if (signal !== null) signal.addEventListener("abort", onAbort);
    const finish = (err: Error | null): void => {
      if (settled) return;
      settled = true;
      if (signal !== null) signal.removeEventListener("abort", onAbort);
      if (err !== null) reject(err);
      else resolve({ status, statusText, headers: rawHeaders, body: Buffer.concat(chunks) });
    };
    const handler: DispatchHandlers = {
      onConnect: (abort: (err?: Error) => void): void => {
        abortFn = abort;
        if (signal !== null && signal.aborted) abort(abortReason(signal));
      },
      onHeaders: (
        statusCode: number,
        raw: Buffer[],
        _resume: () => void,
        text: string,
      ): boolean => {
        if (statusCode < 200) return true;
        status = statusCode;
        statusText = text;
        rawHeaders = [];
        for (const b of raw) rawHeaders.push(b.toString("latin1"));
        return true;
      },
      onData: (chunk: Buffer): boolean => {
        chunks.push(chunk);
        return true;
      },
      onComplete: (_trailers: string[] | null): void => finish(null),
      onError: (err: Error): void => finish(err),
    };
    dispatcher.dispatch(
      {
        origin: url.origin,
        path: url.pathname + url.search,
        method,
        headers,
        body,
      },
      handler,
    );
  });
}

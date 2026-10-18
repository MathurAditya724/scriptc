// Small shared helpers: filesystem probes, hashing, subprocesses.
//
// Everything here must compile natively with scriptc, so the code sticks to the
// Node surface that scriptc lowers today: sync fs, `spawn` with Buffer chunks,
// `createHash`, and plain records.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

export function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** Every regular file under `root`, as sorted `/`-separated relative paths.
 * Directories named in `skip` are not entered; symlinks are not followed. */
export function walkFiles(root: string, skip: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const stack: string[] = [""];
  while (stack.length > 0) {
    const rel = stack.pop() ?? "";
    const abs = rel === "" ? root : join(root, rel);
    let names: string[];
    try {
      names = readdirSync(abs);
    } catch {
      continue;
    }
    for (const name of names) {
      const childRel = rel === "" ? name : `${rel}/${name}`;
      const childAbs = join(root, childRel);
      if (isSymlink(childAbs)) continue;
      if (isDir(childAbs)) {
        if (!skip.has(name)) stack.push(childRel);
      } else if (isFile(childAbs)) {
        out.push(childRel);
      }
    }
  }
  out.sort();
  return out;
}

export function copyTree(from: string, to: string, files: readonly string[]): void {
  for (const rel of files) {
    const dest = join(to, rel);
    const slash = dest.lastIndexOf("/");
    mkdirSync(dest.slice(0, slash), { recursive: true });
    copyFileSync(join(from, rel), dest);
  }
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** git's blob id for file bytes: sha1("blob <len>\0" + bytes). */
export function gitBlobSha1(bytes: Buffer): string {
  const h = createHash("sha1");
  h.update(`blob ${bytes.length}\0`);
  h.update(bytes);
  return h.digest("hex");
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a command to completion with piped output. Never throws for a nonzero
 * exit; a spawn failure (missing binary) is reported as code 127. */
export function run(
  cmd: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
): Promise<RunResult> {
  return new Promise<RunResult>((resolvePromise) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let settled = false;
    const child = spawn(cmd, args, { cwd: cwd, env: env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (chunk: Buffer) => {
      out.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      err.push(chunk);
    });
    child.on("error", (error: Error) => {
      if (settled) return;
      settled = true;
      resolvePromise({ code: 127, stdout: "", stderr: error.message });
    });
    child.on("close", (code: number | null) => {
      if (settled) return;
      settled = true;
      resolvePromise({
        code: code ?? 1,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      });
    });
  });
}

/** Run a command with the terminal attached (used for pnpm itself). */
export function runInherit(cmd: string, args: string[], cwd: string): Promise<number> {
  return new Promise<number>((resolvePromise) => {
    let settled = false;
    const child = spawn(cmd, args, { cwd: cwd, stdio: "inherit" });
    child.on("error", () => {
      if (settled) return;
      settled = true;
      resolvePromise(127);
    });
    child.on("close", (code: number | null) => {
      if (settled) return;
      settled = true;
      resolvePromise(code ?? 1);
    });
  });
}

/** A copy of the process environment as a plain string record. */
export function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of Object.keys(process.env)) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/** Run `tasks` with at most `limit` in flight; results keep input order. */
export async function pool<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await task(items[index] as T);
    }
  };
  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(limit, items.length); i += 1) workers.push(worker());
  await Promise.all(workers);
  return results;
}

/** Strip comments and trailing commas from JSONC (tsconfig) text. */
export function stripJsonc(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i] as string;
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
    } else {
      out += c;
      i += 1;
    }
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

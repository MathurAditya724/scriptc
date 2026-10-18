// Fetching a repository tree at an exact commit into the content-addressed
// cache (DESIGN.md §5.2.1): a blobless, sparse git fetch when git is available,
// or the codeload archive with an in-process gzip + tar reader for public
// GitHub repositories.
//
// Cache layout: `<cache>/trees/<host>/<owner>/<repo>/<commit>/`. The git
// variant is a sparse checkout that starts with every `package.json` and the
// root configs (enough to locate the package directory) and is widened to the
// package directory on demand.

import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { cacheRoot } from "./registry.js";
import type { RepoRef } from "./repo.js";
import { baseEnv, errorMessage, isDir, isFile, readText, run } from "./util.js";

export type FetchMode = "git" | "codeload";

export interface Tree {
  root: string;
  mode: FetchMode;
}

const inflight = new Map<string, Promise<Tree>>();
const widenLocks = new Map<string, Promise<void>>();

/** Fetch (or reuse) the tree for `repo` at `commit`. Concurrent callers for
 * the same tree share one fetch. */
export function fetchTree(repo: RepoRef, commit: string, mode: FetchMode): Promise<Tree> {
  const key = `${repo.id}@${commit}`;
  const existing = inflight.get(key);
  if (existing !== undefined) return existing;
  const promise = fetchTreeUncached(repo, commit, mode);
  inflight.set(key, promise);
  return promise;
}

async function fetchTreeUncached(repo: RepoRef, commit: string, mode: FetchMode): Promise<Tree> {
  const dest = join(cacheRoot(), "trees", repo.id, commit);
  if (isDir(join(dest, ".git"))) return { root: dest, mode: "git" };
  if (isFile(join(dest, ".spm-complete"))) return { root: dest, mode: "codeload" };
  mkdirSync(join(cacheRoot(), "tmp"), { recursive: true });
  const tmp = join(
    cacheRoot(),
    "tmp",
    `${commit}-${process.pid}-${Math.random().toString(36).slice(2)}`,
  );
  try {
    let fetched: FetchMode = mode;
    if (mode === "git") {
      const err = await gitFetch(repo, commit, tmp);
      if (err !== null) {
        if (repo.githubPath === "") throw new Error(err);
        // One transport fallback (DESIGN.md §8.7): git → archive.
        rmSync(tmp, { recursive: true, force: true });
        await codeloadFetch(repo, commit, tmp);
        fetched = "codeload";
      }
    } else {
      await codeloadFetch(repo, commit, tmp);
    }
    mkdirSync(dest.slice(0, dest.lastIndexOf("/")), { recursive: true });
    try {
      renameSync(tmp, dest);
    } catch {
      // A concurrent process published the same tree first.
      if (!isDir(dest)) throw new Error("source cache rename failed");
    }
    return { root: dest, mode: fetched };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Make `subdir` (and the root configs) present in a git tree. Codeload
 * trees are complete already. */
export async function widenTree(tree: Tree, subdir: string): Promise<void> {
  if (tree.mode !== "git") return;
  const previous = widenLocks.get(tree.root) ?? Promise.resolve();
  const next = previous.then(() => widenTreeNow(tree.root, subdir));
  widenLocks.set(
    tree.root,
    next.catch(() => {}),
  );
  return next;
}

async function widenTreeNow(root: string, subdir: string): Promise<void> {
  const sparseFile = join(root, ".git", "info", "sparse-checkout");
  const current = readText(sparseFile) ?? "";
  const pattern = subdir === "" ? "/*" : `/${subdir}/`;
  if (current.split("\n").includes(pattern)) return;
  writeFileSync(sparseFile, `${current}${pattern}\n`);
  const res = await run("git", ["sparse-checkout", "reapply"], root, gitEnv(""));
  if (res.code !== 0) throw new Error(`git sparse-checkout failed: ${firstLine(res.stderr)}`);
}

function gitEnv(host: string): Record<string, string> {
  const env = baseEnv();
  env["GIT_TERMINAL_PROMPT"] = "0";
  env["GIT_SSH_COMMAND"] = "ssh -o BatchMode=yes";
  const token = githubToken();
  if (host === "github.com" && token !== "") {
    // Inject the header through env config: never in argv (DESIGN.md §8.2).
    const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
    env["GIT_CONFIG_COUNT"] = "1";
    env["GIT_CONFIG_KEY_0"] = "http.https://github.com/.extraheader";
    env["GIT_CONFIG_VALUE_0"] = `AUTHORIZATION: basic ${basic}`;
  }
  return env;
}

function githubToken(): string {
  return process.env["GITHUB_TOKEN"] ?? process.env["GH_TOKEN"] ?? "";
}

function firstLine(text: string): string {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
  return lines.length === 0 ? "(no output)" : (lines[lines.length - 1] as string);
}

/** Returns null on success or a reason string. */
async function gitFetch(repo: RepoRef, commit: string, dir: string): Promise<string | null> {
  const env = gitEnv(repo.host);
  mkdirSync(dir, { recursive: true });
  const init = await run("git", ["init", "-q"], dir, env);
  if (init.code === 127) return "git-unavailable";
  if (init.code !== 0) return `git init failed: ${firstLine(init.stderr)}`;
  const fetched = await run(
    "git",
    ["fetch", "-q", "--depth", "1", "--filter=blob:none", repo.remote, commit],
    dir,
    env,
  );
  if (fetched.code !== 0) return classifyGitError(fetched.stderr);
  const config = await run("git", ["config", "core.sparseCheckout", "true"], dir, env);
  if (config.code !== 0) return `git config failed: ${firstLine(config.stderr)}`;
  writeFileSync(join(dir, ".git", "info", "sparse-checkout"), "/*.json\npackage.json\n");
  const checkout = await run("git", ["checkout", "-q", "--detach", commit], dir, env);
  if (checkout.code !== 0) return `git checkout failed: ${firstLine(checkout.stderr)}`;
  return null;
}

function classifyGitError(stderr: string): string {
  if (/not our ref|couldn't find remote ref|unadvertised object/i.test(stderr)) {
    return "commit-not-found";
  }
  if (/repository not found|could not read username|authentication failed|403/i.test(stderr)) {
    return "not-found-or-no-access";
  }
  if (/permission denied \(publickey\)|host key verification/i.test(stderr)) return "ssh-batchmode";
  return `git fetch failed: ${firstLine(stderr)}`;
}

async function codeloadFetch(repo: RepoRef, commit: string, dir: string): Promise<void> {
  if (repo.githubPath === "") throw new Error(`no archive endpoint for ${repo.host}`);
  const base = process.env["SPM_CODELOAD"] ?? "https://codeload.github.com";
  const url = `${base}/${repo.githubPath}/tar.gz/${commit}`;
  const token = githubToken();
  const headers: Record<string, string> = {};
  if (token !== "") headers["authorization"] = `Bearer ${token}`;
  let bytes: Buffer;
  try {
    const res = await fetch(url, { headers: headers, signal: AbortSignal.timeout(300_000) });
    if (res.status === 404) throw new Error("not-found-or-no-access");
    if (!res.ok) throw new Error(`archive fetch failed (HTTP ${res.status})`);
    bytes = Buffer.from(await res.arrayBuffer());
  } catch (error) {
    throw new Error(errorMessage(error));
  }
  extractTarGz(bytes, dir, commit);
  writeFileSync(join(dir, ".spm-complete"), `${commit}\n`);
}

// ── tar ──────────────────────────────────────────────────────────────────

function cString(bytes: Buffer, start: number, length: number): string {
  let end = start;
  while (end < start + length && bytes[end] !== 0) end += 1;
  return bytes.toString("utf8", start, end);
}

function octal(bytes: Buffer, start: number, length: number): number {
  const text = cString(bytes, start, length).trim();
  return text === "" ? 0 : parseInt(text, 8);
}

function paxRecords(body: string): Map<string, string> {
  const records = new Map<string, string>();
  let i = 0;
  while (i < body.length) {
    const space = body.indexOf(" ", i);
    if (space < 0) break;
    const length = parseInt(body.slice(i, space), 10);
    if (!(length > 0)) break;
    const record = body.slice(space + 1, i + length - 1);
    const eq = record.indexOf("=");
    if (eq > 0) records.set(record.slice(0, eq), record.slice(eq + 1));
    i += length;
  }
  return records;
}

/** Extract a GitHub archive (single top-level directory, stripped) into
 * `dir`. Rejects absolute and `..` paths; skips symlinks and hardlinks. */
export function extractTarGz(gz: Buffer, dir: string, commit: string): void {
  const bytes = gunzipSync(gz);
  let offset = 0;
  let longName = "";
  let paxPath = "";
  let sawCommit = false;
  while (offset + 512 <= bytes.length) {
    if (bytes[offset] === 0) break;
    const size = octal(bytes, offset + 124, 12);
    const type = String.fromCharCode(bytes[offset + 156] ?? 48);
    const dataStart = offset + 512;
    const next = dataStart + Math.ceil(size / 512) * 512;
    if (type === "g" || type === "x") {
      const records = paxRecords(bytes.toString("utf8", dataStart, dataStart + size));
      if (type === "g" && records.get("comment") === commit) sawCommit = true;
      if (type === "x") paxPath = records.get("path") ?? "";
      offset = next;
      continue;
    }
    if (type === "L") {
      longName = cString(bytes, dataStart, size);
      offset = next;
      continue;
    }
    let name = cString(bytes, offset, 100);
    const prefix = cString(bytes, offset + 345, 155);
    if (prefix !== "") name = `${prefix}/${name}`;
    if (longName !== "") name = longName;
    if (paxPath !== "") name = paxPath;
    longName = "";
    paxPath = "";
    offset = next;
    const slash = name.indexOf("/");
    const rel = slash < 0 ? "" : name.slice(slash + 1);
    if (rel === "" || rel.startsWith("/") || rel.split("/").includes("..")) continue;
    if (type === "5") {
      mkdirSync(join(dir, rel), { recursive: true });
    } else if (type === "0" || type === "\0" || type === "7") {
      const dest = join(dir, rel);
      mkdirSync(dest.slice(0, dest.lastIndexOf("/")), { recursive: true });
      writeFileSync(dest, bytes.subarray(dataStart, dataStart + size));
    }
  }
  if (!sawCommit) throw new Error("archive does not carry the requested commit");
}

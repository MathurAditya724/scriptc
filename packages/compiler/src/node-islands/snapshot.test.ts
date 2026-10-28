import { chmodSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { probeHostDirectory } from "./snapshot.js";

const saved = { ...process.env };
const made: string[] = [];
afterEach(() => {
  for (const key of ["SCRIPTC_CACHE_DIR", "SCRIPTC_NO_CACHE"]) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "scriptc-probe-dir-")));
  made.push(dir);
  return dir;
}

function probeDir(hash: string): { dir: string; kept: boolean } {
  const result = probeHostDirectory(hash);
  if (!result.kept) made.push(result.dir);
  return result;
}

describe.skipIf(process.platform === "win32")("the probe host's directory", () => {
  test("is kept in the user's private build cache", () => {
    const cache = scratch();
    process.env["SCRIPTC_CACHE_DIR"] = cache;
    const { dir, kept } = probeDir("0123456789abcdef");
    expect(kept).toBe(true);
    expect(dir).toBe(join(cache, "node-island-probe", "0123456789abcdef"));
    expect(statSync(dir).mode & 0o077).toBe(0);
  });

  test("never comes from a cache another user can write", () => {
    const cache = scratch();
    chmodSync(cache, 0o777);
    process.env["SCRIPTC_CACHE_DIR"] = cache;
    const { dir, kept } = probeDir("0123456789abcdef");
    expect(kept).toBe(false);
    expect(dir.startsWith(cache)).toBe(false);
    expect(statSync(dir).mode & 0o077).toBe(0);
    // A second probe gets its own directory: nothing is reused.
    expect(probeDir("0123456789abcdef").dir).not.toBe(dir);
  });

  test("is a fresh private directory without a build cache", () => {
    process.env["SCRIPTC_NO_CACHE"] = "1";
    const { dir, kept } = probeDir("0123456789abcdef");
    expect(kept).toBe(false);
    expect(statSync(dir).mode & 0o077).toBe(0);
  });
});

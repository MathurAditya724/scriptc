import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { libnodeRecord, NODE_BRIDGE_ABI } from "./libnode.js";

function pack(nodeVersion: string, bridgeAbi = NODE_BRIDGE_ABI): string {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-libnode-"));
  writeFileSync(join(dir, "libnode.so.137"), "lib");
  writeFileSync(join(dir, "libscr_node_bridge.so"), "bridge");
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      nodeVersion,
      bridgeAbi,
      files: { "libnode.so.137": {}, "libscr_node_bridge.so": {} },
    }),
  );
  return dir;
}

describe("the recorded libnode pack", () => {
  test("records the pack directory and its exact Node version", () => {
    const dir = pack("24.22.0");
    expect(libnodeRecord(dir, "/out/app", {})).toEqual({ libnode: dir, nodeVersion: "24.22.0" });
    expect(libnodeRecord(undefined, "/out/app", { SCRIPTC_LIBNODE: dir })).toEqual({
      libnode: dir,
      nodeVersion: "24.22.0",
    });
  });

  test("refuses a missing, too old or incompatible pack", () => {
    expect(libnodeRecord(undefined, "/out/app", {})).toMatch(/no libnode pack is installed/);
    expect(libnodeRecord("/nonexistent", "/out/app", {})).toBe(
      "no libnode pack at /nonexistent (manifest.json is missing or unreadable)",
    );
    expect(libnodeRecord(pack("24.12.0"), "/out/app", {})).toMatch(
      /is Node 24\.12\.0; Node islands need Node\.js >=24\.13\.1$/,
    );
    expect(libnodeRecord(pack("24.22.0", 99), "/out/app", {})).toMatch(/has bridge ABI 99/);
    expect(libnodeRecord("relative/pack", "/out/app", {})).toBe(
      "the libnode pack directory must be absolute, got 'relative/pack'",
    );
  });

  test("beside copies the pack next to the executable and records it relative to it", () => {
    const dir = pack("24.22.0");
    const out = mkdtempSync(join(tmpdir(), "scriptc-libnode-out-"));
    mkdirSync(out, { recursive: true });
    expect(libnodeRecord("beside", join(out, "app"), { SCRIPTC_LIBNODE: dir })).toEqual({
      libnode: "$ORIGIN/app.libnode",
      nodeVersion: "24.22.0",
    });
    expect(readFileSync(join(out, "app.libnode/libscr_node_bridge.so"), "utf8")).toBe("bridge");
    expect(existsSync(join(out, "app.libnode/manifest.json"))).toBe(true);
  });

  test("a pack the deployment places beside the executable needs no manifest at build time", () => {
    expect(libnodeRecord("$ORIGIN/node", "/out/app", {})).toEqual({
      libnode: "$ORIGIN/node",
      nodeVersion: "",
    });
  });
});

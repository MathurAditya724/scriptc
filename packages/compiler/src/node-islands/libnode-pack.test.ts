import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import {
  LIBNODE_BRIDGE_ABI,
  LIBNODE_ORIGIN,
  LIBNODE_PACK_SCHEMA,
  LibnodePackError,
  libnodeIdentity,
  libnodePackPackage,
  parseLibnodeSetting,
  placeLibnode,
  readLibnodePack,
  resolveLibnodePack,
  writeLibnodeNotices,
} from "./libnode-pack.js";

const repo = fileURLToPath(new URL("../../../..", import.meta.url));
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-libnode-pack-"));
  dirs.push(dir);
  return dir;
}

function entry(bytes: string) {
  return {
    size: Buffer.byteLength(bytes),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

/** A pack with stand-in libraries; `edit` adjusts the manifest. */
function fakePack(
  dir: string,
  edit: (manifest: Record<string, unknown>) => void = () => {},
  name = "@scriptc/libnode-linux-x64-gnu",
): string {
  mkdirSync(dir, { recursive: true });
  const libnode = "stand-in libnode";
  const bridge = "stand-in bridge";
  writeFileSync(join(dir, "libnode.so.137"), libnode);
  writeFileSync(join(dir, "libscr_node_bridge.so"), bridge);
  writeFileSync(join(dir, "LICENSE"), "Node.js is licensed for use as follows:\n\nMIT\n");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "0.4.1" }));
  const manifest: Record<string, unknown> = {
    schema: LIBNODE_PACK_SCHEMA,
    package: name,
    version: "0.4.1",
    platform: "linux-x64-gnu",
    os: "linux",
    arch: "x64",
    nodeVersion: "24.22.0",
    moduleVersion: 137,
    bridgeAbi: LIBNODE_BRIDGE_ABI,
    libnode: "libnode.so.137",
    bridge: "libscr_node_bridge.so",
    license: "LICENSE",
    files: { "libnode.so.137": entry(libnode), "libscr_node_bridge.so": entry(bridge) },
  };
  edit(manifest);
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  return dir;
}

function thrown(run: () => unknown): LibnodePackError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(LibnodePackError);
    return error as LibnodePackError;
  }
  throw new Error("expected a LibnodePackError");
}

describe("the pack packages", () => {
  test("every libnode platform package is the pack of one native target", () => {
    const packages = readdirSync(join(repo, "packages"))
      .filter((name) => name.startsWith("libnode-") && name !== "libnode-common")
      .map(
        (name) =>
          JSON.parse(readFileSync(join(repo, "packages", name, "package.json"), "utf8")).name,
      )
      .sort();
    const targets = ["linux-x64-gnu", "linux-arm64-gnu", "macos-arm64", "macos-x64"];
    expect(targets.map((target) => libnodePackPackage(target)).sort()).toEqual(packages);
    expect(libnodePackPackage("linux-x64-musl")).toBeNull();
    expect(libnodePackPackage("windows-x64-msvc")).toBeNull();
    expect(libnodePackPackage("wasm32-wasi")).toBeNull();
  });

  test("the bridge ABI matches the runtime header", () => {
    const header = readFileSync(join(repo, "packages/runtime/src/scr_node_bridge.h"), "utf8");
    expect(header).toContain(`#define SCR_NODE_BRIDGE_ABI ${LIBNODE_BRIDGE_ABI}u`);
  });
});

describe("parseLibnodeSetting", () => {
  test("accepts embedded, beside and absolute directories", () => {
    expect(parseLibnodeSetting("embedded")).toEqual({ kind: "embedded" });
    expect(parseLibnodeSetting("beside")).toEqual({ kind: "beside" });
    expect(parseLibnodeSetting("/opt/scriptc/libnode-24.22.0")).toEqual({
      kind: "path",
      path: "/opt/scriptc/libnode-24.22.0",
    });
  });

  test("rejects relative paths and other values", () => {
    expect(parseLibnodeSetting("libnode")).toBe(
      'must be "embedded", "beside" or an absolute directory, not the relative path "libnode"',
    );
    expect(parseLibnodeSetting(true)).toBe('must be "embedded", "beside" or an absolute directory');
  });
});

describe("resolveLibnodePack", () => {
  test("SCRIPTC_LIBNODE names the pack directory", () => {
    const pack = fakePack(join(temp(), "pack"));
    const found = resolveLibnodePack({
      targetName: "linux-x64-gnu",
      projectDir: temp(),
      env: { SCRIPTC_LIBNODE: pack },
      verifyHashes: true,
    });
    expect(found.root).toBe(pack);
    expect(found.source).toBe("env");
    expect(found.manifest.nodeVersion).toBe("24.22.0");
  });

  test("SCRIPTC_LIBNODE must be absolute", () => {
    const error = thrown(() =>
      resolveLibnodePack({
        targetName: "linux-x64-gnu",
        projectDir: temp(),
        env: { SCRIPTC_LIBNODE: "relative/pack" },
      }),
    );
    expect(error.message).toBe(
      "SCRIPTC_LIBNODE must be an absolute pack directory, got 'relative/pack'",
    );
  });

  test("finds the package in the nearest node_modules above the project", () => {
    const root = temp();
    const pack = fakePack(join(root, "node_modules/@scriptc/libnode-linux-x64-gnu"));
    const project = join(root, "apps/web/src");
    mkdirSync(project, { recursive: true });
    const found = resolveLibnodePack({
      targetName: "linux-x64-gnu",
      projectDir: project,
      env: {},
      resolveInstalled: () => null,
    });
    expect(found.root).toBe(pack);
    expect(found.source).toBe("installed");
  });

  test("falls back to the package next to the compiler", () => {
    const pack = fakePack(join(temp(), "libnode-linux-x64-gnu"));
    const found = resolveLibnodePack({
      targetName: "linux-x64-gnu",
      projectDir: temp(),
      env: {},
      resolveInstalled: (name) => (name === "@scriptc/libnode-linux-x64-gnu" ? pack : null),
    });
    expect(found.root).toBe(pack);
  });

  test("names the package to install when none is found", () => {
    const error = thrown(() =>
      resolveLibnodePack({
        targetName: "macos-arm64",
        projectDir: temp(),
        env: {},
        resolveInstalled: () => null,
      }),
    );
    expect(error.kind).toBe("missing");
    expect(error.message).toBe(
      "this program needs Node.js (Node islands), but @scriptc/libnode-darwin-arm64 is not installed: install it in the project, or set SCRIPTC_LIBNODE to a libnode pack directory",
    );
  });

  test("targets without packs are unsupported", () => {
    const error = thrown(() =>
      resolveLibnodePack({ targetName: "linux-x64-musl", projectDir: temp(), env: {} }),
    );
    expect(error.kind).toBe("unsupported");
  });

  test("a pack for another platform is refused", () => {
    const pack = fakePack(join(temp(), "pack"));
    const error = thrown(() =>
      resolveLibnodePack({
        targetName: "linux-arm64-gnu",
        projectDir: temp(),
        env: { SCRIPTC_LIBNODE: pack },
      }),
    );
    expect(error.message).toBe(
      `the libnode pack at ${pack} is @scriptc/libnode-linux-x64-gnu; this target needs @scriptc/libnode-linux-arm64-gnu`,
    );
  });
});

describe("readLibnodePack", () => {
  test("refuses another bridge ABI", () => {
    const pack = fakePack(join(temp(), "pack"), (m) => {
      m["bridgeAbi"] = LIBNODE_BRIDGE_ABI + 1;
    });
    expect(thrown(() => readLibnodePack(pack, "env")).message).toBe(
      `the libnode pack at ${pack} has bridge ABI ${LIBNODE_BRIDGE_ABI + 1}; this scriptc needs ${LIBNODE_BRIDGE_ABI}`,
    );
  });

  test("refuses Node releases below the minimum", () => {
    const pack = fakePack(join(temp(), "pack"), (m) => {
      m["nodeVersion"] = "24.13.0";
    });
    expect(thrown(() => readLibnodePack(pack, "env")).message).toBe(
      `the libnode pack at ${pack} is Node 24.13.0; Node islands need Node.js >=24.13.1`,
    );
    const ok = fakePack(join(temp(), "pack"), (m) => {
      m["nodeVersion"] = "24.13.1";
    });
    expect(readLibnodePack(ok, "env").manifest.nodeVersion).toBe("24.13.1");
  });

  test("refuses other manifest schemas and nested file names", () => {
    const schema = fakePack(join(temp(), "pack"), (m) => {
      m["schema"] = "scriptc.libnode-pack.v0";
    });
    expect(thrown(() => readLibnodePack(schema, "env")).kind).toBe("invalid");
    const nested = fakePack(join(temp(), "pack"), (m) => {
      m["libnode"] = "lib/libnode.so.137";
      m["files"] = {
        ...(m["files"] as object),
        "lib/libnode.so.137": entry("stand-in libnode"),
      };
    });
    expect(thrown(() => readLibnodePack(nested, "env")).message).toContain("nested file");
  });

  test("checks sizes always and hashes on request", () => {
    const pack = fakePack(join(temp(), "pack"));
    writeFileSync(join(pack, "libnode.so.137"), "stand-in libnodE");
    expect(readLibnodePack(pack, "env").root).toBe(pack);
    expect(thrown(() => readLibnodePack(pack, "env", { verifyHashes: true })).message).toBe(
      `libnode.so.137 in the libnode pack at ${pack} does not match its manifest`,
    );
    writeFileSync(join(pack, "libnode.so.137"), "short");
    expect(thrown(() => readLibnodePack(pack, "env")).kind).toBe("invalid");
  });

  test("a directory without a manifest is missing", () => {
    const dir = temp();
    expect(thrown(() => readLibnodePack(dir, "env")).message).toBe(
      `no libnode pack at ${dir} (manifest.json is missing or unreadable)`,
    );
  });
});

describe("placing a pack", () => {
  test("beside copies the pack next to the output and records it relative to it", () => {
    const pack = readLibnodePack(fakePack(join(temp(), "pack")), "env");
    const out = join(temp(), "server");
    const placed = placeLibnode(pack, { kind: "beside" }, out);
    expect(placed.location).toBe(`${LIBNODE_ORIGIN}server.libnode`);
    expect(readdirSync(`${out}.libnode`).sort()).toEqual([
      "LICENSE",
      "libnode.so.137",
      "libscr_node_bridge.so",
      "manifest.json",
    ]);
    expect(statSync(join(`${out}.libnode`, "libnode.so.137")).size).toBe(16);
    // The placed directory is itself a valid pack.
    expect(readLibnodePack(`${out}.libnode`, "env", { verifyHashes: true }).manifest.package).toBe(
      "@scriptc/libnode-linux-x64-gnu",
    );
  });

  test("an absolute directory is recorded as is and nothing is copied", () => {
    const pack = readLibnodePack(fakePack(join(temp(), "pack")), "env");
    expect(placeLibnode(pack, { kind: "path", path: "/opt/libnode" }, join(temp(), "a"))).toEqual({
      location: "/opt/libnode",
      files: [],
    });
  });

  test("embedded is refused until the runtime can extract it", () => {
    const pack = readLibnodePack(fakePack(join(temp(), "pack")), "env");
    expect(thrown(() => placeLibnode(pack, { kind: "embedded" }, join(temp(), "a"))).kind).toBe(
      "unsupported",
    );
  });

  test("the identity names both libraries with sizes and hashes", () => {
    const pack = readLibnodePack(fakePack(join(temp(), "pack")), "env");
    expect(libnodeIdentity(pack)).toEqual({
      nodeVersion: "24.22.0",
      moduleVersion: 137,
      bridgeAbi: LIBNODE_BRIDGE_ABI,
      libnode: { name: "libnode.so.137", ...entry("stand-in libnode") },
      bridge: { name: "libscr_node_bridge.so", ...entry("stand-in bridge") },
    });
  });

  test("the license notices carry Node's LICENSE", () => {
    const pack = readLibnodePack(fakePack(join(temp(), "pack")), "env");
    const out = join(temp(), "server");
    const path = writeLibnodeNotices(pack, out);
    expect(path).toBe(`${out}.licenses.txt`);
    expect(readFileSync(path, "utf8")).toBe(
      [
        "server runs part of its code in Node.js 24.22.0, loaded from libnode.so.137",
        "(@scriptc/libnode-linux-x64-gnu@0.4.1). Node.js and the components it bundles are",
        "licensed as follows. The scriptc bridge, libscr_node_bridge.so, is licensed under Apache-2.0.",
        "",
        "Node.js is licensed for use as follows:",
        "",
        "MIT",
        "",
      ].join("\n"),
    );
  });
});

#!/usr/bin/env node
// Compiles the libnode bridge (bridge/scr_node_bridge.cc) against the
// headers of one exact Node release and links it to that release's
// libnode, which must sit next to it: the bridge finds libnode through
// $ORIGIN (Linux) or @loader_path (macOS), so a pack directory can move.
//
// The pack build calls this after building or restoring libnode; it is also
// the bridge-only rebuild path (seconds) when the bridge changes but the
// Node pin does not, and the way a self-builder pairs the bridge with a
// compatible Node `--shared` build of their own:
//
//   node packages/libnode-common/scripts/build-bridge.mjs \
//     --headers <dir containing include/node> --libnode <libnode.so.N> --out <dir>
import { execFileSync } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { bridgeHeader, bridgeSource } from "./pin.mjs";

/**
 * @param {{ headers: string, libnode: string, out: string, os?: string, cxx?: string }} options
 *   headers: the directory that contains include/node; libnode: the library
 *   the bridge links (already in the pack directory `dirname(out)`).
 */
export function buildBridge(options) {
  const os = options.os ?? process.platform;
  const cxx = options.cxx ?? process.env.CXX ?? (os === "darwin" ? "clang++" : "g++");
  const include = join(options.headers, "include", "node");
  const libdir = dirname(options.libnode);
  const link =
    os === "darwin"
      ? [
          "-dynamiclib",
          options.libnode,
          "-Wl,-rpath,@loader_path",
          `-Wl,-install_name,@rpath/${basename(options.out)}`,
        ]
      : [
          "-shared",
          `-L${libdir}`,
          `-l:${basename(options.libnode)}`,
          "-Wl,-rpath,$ORIGIN",
          "-Wl,-z,defs",
          "-Wl,--as-needed",
          "-ldl",
          "-pthread",
        ];
  execFileSync(
    cxx,
    [
      "-std=c++20",
      "-O2",
      "-fPIC",
      "-fvisibility=hidden",
      "-fno-rtti",
      "-I",
      dirname(bridgeHeader),
      "-I",
      include,
      bridgeSource,
      ...link,
      "-o",
      options.out,
    ],
    { stdio: "inherit" },
  );
  if (os === "darwin") {
    execFileSync("strip", ["-x", options.out], { stdio: "inherit" });
    execFileSync("codesign", ["--force", "--sign", "-", options.out], { stdio: "inherit" });
  } else {
    execFileSync("strip", ["--strip-unneeded", options.out], { stdio: "inherit" });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      headers: { type: "string" },
      libnode: { type: "string" },
      out: { type: "string" },
      cxx: { type: "string" },
    },
  });
  if (!values.headers || !values.libnode || !values.out) {
    console.error("usage: build-bridge.mjs --headers <dir> --libnode <library> --out <bridge>");
    process.exit(2);
  }
  buildBridge({
    headers: resolve(values.headers),
    libnode: resolve(values.libnode),
    out: resolve(values.out),
    cxx: values.cxx,
  });
}

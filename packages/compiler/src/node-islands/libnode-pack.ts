/* Locating, validating and placing a libnode pack (scope-B design §2.11,
 * §2.13, §2.16.3): the directory a program with Node islands loads Node
 * from. A pack holds a stripped Node.js shared library built from one exact
 * release, the scriptc bridge compiled against that release
 * (packages/libnode-common), Node's LICENSE and manifest.json. Packs are
 * built only by the libnode-packs workflow and installed like the runtime
 * packs, as `@scriptc/libnode-<platform>`; a scriptc build never compiles
 * Node.
 *
 * Where the build finds the pack, in order:
 *   1. SCRIPTC_LIBNODE in the build's environment: an absolute pack
 *      directory (a self-built pack, or a CI artifact);
 *   2. `@scriptc/libnode-<platform>` installed in the project (the nearest
 *      node_modules walking up from the project directory), else next to
 *      the compiler.
 *
 * How the program finds it at run time is the `nodeIslands.libnode`
 * setting (parseLibnodeSetting):
 *   "embedded"  the libraries travel inside the executable and are
 *               extracted to the cache on first use (the default; the
 *               runtime extraction lands with island packaging, NI-4);
 *   "beside"    a copy of the pack next to the output, `<output>.libnode/`,
 *               recorded relative to the executable;
 *   <path>      an absolute directory where the deployment host installs
 *               the same pack; nothing is copied.
 * SCRIPTC_LIBNODE in the program's environment overrides the recorded
 * location at run time; the runtime checks the identity recorded here
 * (libnodeIdentity) before it dlopens anything. */
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

export const LIBNODE_PACK_SCHEMA = "scriptc.libnode-pack.v1";

/** The bridge ABI this compiler's runtime speaks (SCR_NODE_BRIDGE_ABI in
 * packages/runtime/src/scr_node_bridge.h). */
export const LIBNODE_BRIDGE_ABI = 1;

/** The oldest Node.js release Node islands support (decision 5). */
export const LIBNODE_MIN_NODE = "24.13.1";

/** The prefix of a recorded location relative to the executable. */
export const LIBNODE_ORIGIN = "$ORIGIN/";

/** The pack package for each native target that can host Node islands. */
const PACK_PACKAGES: Readonly<Record<string, string>> = {
  "linux-x64-gnu": "@scriptc/libnode-linux-x64-gnu",
  "linux-arm64-gnu": "@scriptc/libnode-linux-arm64-gnu",
  "macos-arm64": "@scriptc/libnode-darwin-arm64",
  "macos-x64": "@scriptc/libnode-darwin-x64",
};

export type LibnodePlacement =
  | { kind: "embedded" }
  | { kind: "beside" }
  | { kind: "path"; path: string };

export interface LibnodeFile {
  size: number;
  sha256: string;
}

export interface LibnodePackManifest {
  schema: string;
  package: string;
  version: string;
  platform: string;
  nodeVersion: string;
  moduleVersion: number;
  bridgeAbi: number;
  /** File names inside the pack directory. */
  libnode: string;
  bridge: string;
  license: string;
  files: Record<string, LibnodeFile>;
}

export interface LibnodePack {
  /** The pack directory. */
  root: string;
  /** How it was found. */
  source: "env" | "installed";
  manifest: LibnodePackManifest;
}

/** What the executable records to find and check its Node at run time. */
export interface LibnodeIdentity {
  nodeVersion: string;
  moduleVersion: number;
  bridgeAbi: number;
  libnode: { name: string } & LibnodeFile;
  bridge: { name: string } & LibnodeFile;
}

export class LibnodePackError extends Error {
  readonly kind: "missing" | "invalid" | "unsupported";

  constructor(message: string, kind: "missing" | "invalid" | "unsupported") {
    super(message);
    this.name = "LibnodePackError";
    this.kind = kind;
  }
}

/** The libnode pack package for a native target, or null when Node islands
 * have no pack there (musl, Windows, WASI and mobile targets: SC8012). */
export function libnodePackPackage(targetName: string): string | null {
  return PACK_PACKAGES[targetName] ?? null;
}

/** Validates a `nodeIslands.libnode` value; a string result is the reason
 * it is invalid. */
export function parseLibnodeSetting(value: unknown): LibnodePlacement | string {
  if (value === "embedded") return { kind: "embedded" };
  if (value === "beside") return { kind: "beside" };
  if (typeof value === "string" && isAbsolute(value)) return { kind: "path", path: value };
  if (typeof value === "string") {
    return `must be "embedded", "beside" or an absolute directory, not the relative path "${value}"`;
  }
  return `must be "embedded", "beside" or an absolute directory`;
}

function versionAtLeast(version: string, floor: string): boolean {
  const a = version.split(".").map(Number);
  const b = floor.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFileEntry(value: unknown): value is LibnodeFile {
  return (
    isRecord(value) &&
    typeof value["size"] === "number" &&
    typeof value["sha256"] === "string" &&
    /^[0-9a-f]{64}$/.test(value["sha256"])
  );
}

/** Parses manifest.json of a pack; throws LibnodePackError when it is not
 * a pack this compiler can use. */
export function parseLibnodePackManifest(json: unknown, where: string): LibnodePackManifest {
  const invalid = (detail: string): never => {
    throw new LibnodePackError(`the libnode pack at ${where} ${detail}`, "invalid");
  };
  if (!isRecord(json)) return invalid("has a malformed manifest.json");
  if (json["schema"] !== LIBNODE_PACK_SCHEMA) {
    return invalid(
      `has manifest schema ${String(json["schema"])}, expected ${LIBNODE_PACK_SCHEMA}`,
    );
  }
  const strings = ["package", "version", "platform", "nodeVersion", "libnode", "bridge", "license"];
  for (const field of strings) {
    if (typeof json[field] !== "string" || json[field] === "") {
      return invalid(`has no ${field} in manifest.json`);
    }
  }
  if (typeof json["moduleVersion"] !== "number" || typeof json["bridgeAbi"] !== "number") {
    return invalid("has no moduleVersion or bridgeAbi in manifest.json");
  }
  const files = json["files"];
  if (!isRecord(files)) return invalid("lists no files in manifest.json");
  for (const name of [json["libnode"], json["bridge"]] as string[]) {
    if (!isFileEntry(files[name])) return invalid(`lists no size and SHA-256 for ${name}`);
    if (name.includes("/") || name.includes("\\")) return invalid(`names a nested file ${name}`);
  }
  const manifest = json as unknown as LibnodePackManifest;
  if (manifest.bridgeAbi !== LIBNODE_BRIDGE_ABI) {
    throw new LibnodePackError(
      `the libnode pack at ${where} has bridge ABI ${manifest.bridgeAbi}; this scriptc needs ${LIBNODE_BRIDGE_ABI}`,
      "invalid",
    );
  }
  if (!versionAtLeast(manifest.nodeVersion, LIBNODE_MIN_NODE)) {
    throw new LibnodePackError(
      `the libnode pack at ${where} is Node ${manifest.nodeVersion}; Node islands need Node.js >=${LIBNODE_MIN_NODE}`,
      "invalid",
    );
  }
  return manifest;
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Reads and checks the pack in `root`: its manifest, and that each library
 * exists with the recorded size (and SHA-256 when `verifyHashes`). */
export function readLibnodePack(
  root: string,
  source: LibnodePack["source"],
  options: { packageName?: string | undefined; verifyHashes?: boolean | undefined } = {},
): LibnodePack {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
  } catch {
    throw new LibnodePackError(
      `no libnode pack at ${root} (manifest.json is missing or unreadable)`,
      "missing",
    );
  }
  const manifest = parseLibnodePackManifest(json, root);
  if (options.packageName !== undefined && manifest.package !== options.packageName) {
    throw new LibnodePackError(
      `the libnode pack at ${root} is ${manifest.package}; this target needs ${options.packageName}`,
      "invalid",
    );
  }
  for (const name of [manifest.libnode, manifest.bridge]) {
    const path = join(root, name);
    const entry = manifest.files[name]!;
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      throw new LibnodePackError(`the libnode pack at ${root} is missing ${name}`, "invalid");
    }
    if (
      size !== entry.size ||
      (options.verifyHashes === true && sha256File(path) !== entry.sha256)
    ) {
      throw new LibnodePackError(
        `${name} in the libnode pack at ${root} does not match its manifest`,
        "invalid",
      );
    }
  }
  return { root, source, manifest };
}

/** The nearest `node_modules/<name>` directory walking up from `from`. */
function findInstalled(name: string, from: string): string | null {
  let dir = resolve(from);
  for (;;) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function resolveNextToCompiler(name: string): string | null {
  try {
    return dirname(createRequire(import.meta.url).resolve(`${name}/package.json`));
  } catch {
    return null;
  }
}

/** Finds the libnode pack a build for `targetName` uses (see the header). */
export function resolveLibnodePack(options: {
  targetName: string;
  projectDir: string;
  env?: NodeJS.ProcessEnv | undefined;
  verifyHashes?: boolean | undefined;
  /** Test hook for the compiler-relative lookup. */
  resolveInstalled?: ((name: string) => string | null) | undefined;
}): LibnodePack {
  const packageName = libnodePackPackage(options.targetName);
  if (packageName === null) {
    throw new LibnodePackError(
      `Node islands have no libnode pack for ${options.targetName}`,
      "unsupported",
    );
  }
  const fromEnv = (options.env ?? process.env)["SCRIPTC_LIBNODE"];
  if (fromEnv !== undefined && fromEnv !== "") {
    if (!isAbsolute(fromEnv)) {
      throw new LibnodePackError(
        `SCRIPTC_LIBNODE must be an absolute pack directory, got '${fromEnv}'`,
        "invalid",
      );
    }
    return readLibnodePack(fromEnv, "env", { packageName, verifyHashes: options.verifyHashes });
  }
  const installed =
    findInstalled(packageName, options.projectDir) ??
    (options.resolveInstalled ?? resolveNextToCompiler)(packageName);
  if (installed === null) {
    throw new LibnodePackError(
      `this program needs Node.js (Node islands), but ${packageName} is not installed: install it in the project, or set SCRIPTC_LIBNODE to a libnode pack directory`,
      "missing",
    );
  }
  return readLibnodePack(installed, "installed", {
    packageName,
    verifyHashes: options.verifyHashes,
  });
}

/** The identity the executable records and the runtime checks before it
 * loads the pack (design §2.2 step 1, §2.11). */
export function libnodeIdentity(pack: LibnodePack): LibnodeIdentity {
  const { manifest } = pack;
  return {
    nodeVersion: manifest.nodeVersion,
    moduleVersion: manifest.moduleVersion,
    bridgeAbi: manifest.bridgeAbi,
    libnode: { name: manifest.libnode, ...manifest.files[manifest.libnode]! },
    bridge: { name: manifest.bridge, ...manifest.files[manifest.bridge]! },
  };
}

function linkOrCopy(from: string, to: string): void {
  try {
    linkSync(from, to);
  } catch {
    copyFileSync(from, to);
  }
}

/** Places the pack for `outPath` according to `placement` and answers the
 * location the executable records: absolute, or relative to the
 * executable's directory behind LIBNODE_ORIGIN. */
export function placeLibnode(
  pack: LibnodePack,
  placement: LibnodePlacement,
  outPath: string,
): { location: string; files: string[] } {
  switch (placement.kind) {
    case "path":
      return { location: placement.path, files: [] };
    case "beside": {
      const name = `${basename(outPath)}.libnode`;
      const target = `${outPath}.libnode`;
      rmSync(target, { recursive: true, force: true });
      mkdirSync(target, { recursive: true });
      const { manifest } = pack;
      const files = [manifest.libnode, manifest.bridge, "manifest.json", manifest.license];
      for (const file of files) linkOrCopy(join(pack.root, file), join(target, file));
      return { location: `${LIBNODE_ORIGIN}${name}`, files: files.map((f) => join(target, f)) };
    }
    case "embedded":
      throw new LibnodePackError(
        `embedded libnode packaging is not available yet; set nodeIslands.libnode to "beside" or an absolute directory`,
        "unsupported",
      );
  }
}

/** Writes the license notices a program that redistributes Node.js must
 * carry, `<output>.licenses.txt` (design §2.13), and returns its path. */
export function writeLibnodeNotices(pack: LibnodePack, outPath: string): string {
  const { manifest } = pack;
  const nodeLicense = readFileSync(join(pack.root, manifest.license), "utf8");
  const path = `${outPath}.licenses.txt`;
  writeFileSync(
    path,
    [
      `${basename(outPath)} runs part of its code in Node.js ${manifest.nodeVersion}, loaded from ${manifest.libnode}`,
      `(${manifest.package}@${manifest.version}). Node.js and the components it bundles are`,
      "licensed as follows. The scriptc bridge, " +
        `${manifest.bridge}, is licensed under Apache-2.0.`,
      "",
      nodeLicense.trimEnd(),
      "",
    ].join("\n"),
  );
  return path;
}

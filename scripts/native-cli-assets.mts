import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import type { NativeTargetSpec } from "../packages/compiler/src/backend/targets.js";
import type { NativeToolchainManifest } from "../packages/compiler/src/native/toolchain.js";
import {
  tscTsExecutable,
  tscTsPlatformPackage,
} from "../packages/compiler/src/frontend/ts7/checker-backend.js";

/** Copy release payloads explicitly; development caches and build trees never ship. */
function copyPackage(source: string, destination: string, members: readonly string[]): void {
  mkdirSync(destination, { recursive: true });
  for (const member of ["package.json", ...members]) {
    cpSync(join(source, member), join(destination, member), {
      recursive: true,
      filter: (path) => ![".cache", "node_modules", ".DS_Store"].includes(basename(path)),
    });
  }
  for (const name of readdirSync(source)) {
    if (/^(?:LICENSE|COPYING|NOTICE|SCRIPTC_LICENSE|THIRD_PARTY_NOTICES)(?:\..*)?$/.test(name)) {
      cpSync(join(source, name), join(destination, name));
    }
  }
}

/** Removes the symbol table and debug sections of a copied executable.
 * llvm-strip rewrites the linker-signed ad hoc code signature of a Mach-O
 * executable, which arm64 macOS requires to run it. Windows executables keep
 * their debug information in separate .pdb files, which are not copied. */
function stripExecutable(path: string, platform: string): void {
  if (platform === "win32") return;
  execFileSync("llvm-strip", [path], { stdio: "inherit" });
}

/** Rewrites CRLF line endings to LF in the text files under `directory`. A
 * Windows checkout converts the repository's LF text files to CRLF; this
 * restores the files the other hosts ship. Text is what Git's conversion
 * treats as text: no NUL byte in the first 8000 bytes. */
function normalizeLineEndings(directory: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      normalizeLineEndings(path);
      continue;
    }
    if (!entry.isFile()) continue;
    const bytes = readFileSync(path);
    if (bytes.subarray(0, 8000).includes(0) || !bytes.includes("\r\n")) continue;
    writeFileSync(path, bytes.toString("latin1").replaceAll("\r\n", "\n"), "latin1");
  }
}

export function stageNativeCliAssets(options: {
  repository: string;
  output: string;
  target: NativeTargetSpec;
  ts7: string;
  compilerVersion: string;
  /** Strip the copied tsc-ts executable. */
  strip: boolean;
}): Pick<
  NativeToolchainManifest,
  | "ts7"
  | "tsc_ts"
  | "llvm_package"
  | "runtime_pack"
  | "runtime_packs"
  | "runtime_sources"
  | "declarations"
  | "wasi_node_runner"
> {
  const { repository, output, target } = options;
  const bin = join(output, "bin");
  const lib = join(output, "lib");
  mkdirSync(lib, { recursive: true });
  cpSync(join(repository, "LICENSE"), join(output, "LICENSE"));
  const helper = join(lib, "llvm");
  const runtime = join(lib, target.runtimePackPackage.replace("@scriptc/", ""));
  copyPackage(
    join(repository, "packages", target.helper.packageName.replace("@scriptc/", "")),
    helper,
    ["bin"],
  );
  copyPackage(
    join(repository, "packages", target.runtimePackPackage.replace("@scriptc/", "")),
    runtime,
    ["artifacts", "runtime-pack.json"],
  );
  const typescript = join(lib, "typescript");
  copyPackage(dirname(dirname(options.ts7)), typescript, ["lib"]);
  // tsc-ts, the default checker, from the tsc-ts package the compiler depends on.
  const tscTsSource = tscTsExecutable(
    [join(repository, "packages/compiler")],
    tscTsPlatformPackage(target.platform, target.architecture, target.name.endsWith("-musl")),
    target.platform,
  );
  const tscTs = join(lib, "tsc-ts");
  copyPackage(dirname(dirname(tscTsSource)), tscTs, ["lib"]);
  if (options.strip) stripExecutable(join(tscTs, "lib", basename(tscTsSource)), target.platform);
  const sources = join(lib, "runtime-sources");
  copyPackage(join(repository, "packages/runtime"), sources, ["src", "vendor"]);
  normalizeLineEndings(sources);
  const declarations = join(lib, "declarations");
  mkdirSync(declarations, { recursive: true });
  for (const name of ["scriptc.d.ts", "scriptc-overrides.d.ts", "scriptc-node-fallback.d.ts"]) {
    cpSync(join(repository, "packages/compiler/ambient", name), join(declarations, name));
  }
  // Package shims (packageShimRoot): the built-in npm package implementations.
  cpSync(join(repository, "packages/compiler/shims"), join(declarations, "shims"), {
    recursive: true,
  });
  normalizeLineEndings(declarations);
  // This optional Node host runs the built WASI module, never the compiler.
  const wasi = join(lib, "wasi");
  mkdirSync(join(wasi, "cli"), { recursive: true });
  writeFileSync(join(wasi, "package.json"), '{"type":"module"}\n');
  for (const name of ["wasi-paths.js", "cli/wasi-paths.js", "cli/wasi-runner.js"]) {
    const source = join(repository, "packages/compiler/dist", name);
    if (!existsSync(source))
      throw new Error("build the compiler workspace before packaging its WASI runner");
    cpSync(source, join(wasi, name));
  }
  const identity = JSON.parse(readFileSync(join(typescript, "package.json"), "utf8")) as {
    version: string;
  };
  const tscTsIdentity = JSON.parse(readFileSync(join(tscTs, "package.json"), "utf8")) as {
    version: string;
  };
  writeFileSync(
    join(output, "THIRD_PARTY_NOTICES"),
    [
      `scriptc ${options.compilerVersion} includes the existing TypeScript ${identity.version}, tsc-ts ${tscTsIdentity.version}, LLVM, and C runtime dependencies.`,
      "TypeScript licensing: lib/typescript/LICENSE and lib/typescript/NOTICE.txt.",
      "tsc-ts licensing and notices: lib/tsc-ts/LICENSE and lib/tsc-ts/THIRD_PARTY_NOTICES.md.",
      "LLVM licensing and notices: lib/llvm/LICENSE and lib/llvm/THIRD_PARTY_NOTICES.",
      "Runtime dependency licenses: lib/runtime-sources/vendor/*/LICENSE*.",
      "",
    ].join("\n"),
  );
  return {
    ts7: relative(bin, join(typescript, "lib", basename(options.ts7))),
    tsc_ts: relative(bin, join(tscTs, "lib", basename(tscTsSource))),
    llvm_package: relative(bin, helper),
    runtime_pack: relative(bin, runtime),
    runtime_packs: [{ target: target.name, path: relative(bin, runtime) }],
    runtime_sources: relative(bin, sources),
    declarations: relative(bin, declarations),
    wasi_node_runner: relative(bin, join(wasi, "cli/wasi-runner.js")),
  };
}

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { nativeCodegenDiag } from "../diagnostics/diagnostic.js";
import type { NativeLinkFeatures } from "./native-link-info.js";
import { RuntimePackError } from "./runtime-pack-core.js";
import { selectNativeRuntimePack } from "./runtime-pack-native.js";
import { WASM32_WASI_TARGET } from "./targets.js";

const dirs: string[] = [];
afterEach(async () =>
  Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))),
);

test("a missing cross-target runtime pack names its package in the diagnostic", async () => {
  const root = await mkdtemp(join(tmpdir(), "scriptc-runtime-pack-native-"));
  dirs.push(root);
  let error: unknown;
  try {
    selectNativeRuntimePack(
      join(root, "runtime-wasm32-wasi"),
      WASM32_WASI_TARGET,
      "0.3.5",
      {} as NativeLinkFeatures,
      "release",
    );
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(RuntimePackError);
  const pack = error as RuntimePackError;
  expect(pack.code).toBe("missing");
  const diagnostic = nativeCodegenDiag("SC3003", pack.message, "main.ts", pack.hint);
  expect(diagnostic.message).toBe(
    "runtime pack for wasm32-wasi is not installed; install @scriptc/runtime-wasm32-wasi@0.3.5 in your project or set SCRIPTC_RUNTIME_PACK to its directory",
  );
  expect(diagnostic.hint).toBe(
    "scriptc includes the runtime pack for its own platform only; other targets need their runtime pack package in the project",
  );
});

test("a missing native helper keeps the reinstall hint", () => {
  expect(nativeCodegenDiag("SC3003", "helper missing", "main.ts").hint).toBe(
    "reinstall scriptc with optional dependencies enabled for this host",
  );
});

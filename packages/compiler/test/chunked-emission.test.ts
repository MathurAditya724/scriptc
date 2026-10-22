import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../src/index.js";
import type { IrModule } from "../src/ir/ir.js";
import { emitLlvmModuleSource, type LlvmTargetOptions } from "../src/backend/llvm/emitter.js";
import { inlineRcOption } from "../src/backend/llvm/shapes.js";

// Programs whose function bodies request module-level helpers and tables
// that the chunk journal (emit-journal.ts) carries: checked-dynamic
// conversions, inspection, publication walkers, live record views, stream
// adapters, regex instances, colliding literal digests, interned C strings,
// speculative loop sites, typed message listeners and readers.
const PROGRAMS = [
  "1003-json-parse-unions.ts",
  "114-live-record-delete.ts",
  "1200-regex-test-basics.ts",
  "1631-inspect-arrays.ts",
  "4598-publish-constructor-stores.ts",
  "4900-console-instances.ts",
  "5612-readable-from-iterables.cjs",
  "5702-publish-candidate-buffers.ts",
  "7321-speculative-loop-bail-sites.ts",
  "7360-worker-typed-records.ts",
  "node24-text-utilities-coercion.js",
];

const OPTIONS: Record<string, LlvmTargetOptions> = {
  release: {},
  speed: {
    targetTriple: "x86_64-unknown-linux-gnu",
    pointerBits: 64,
    runtimeAbiMarker: true,
    lowRegion: true,
    ...inlineRcOption("speed", false),
  },
};

const text = (out: string | readonly string[]): string =>
  typeof out === "string" ? out : out.join("");

async function lower(program: string, dir: string): Promise<string> {
  const entry = join(import.meta.dirname, "../../../tests/corpus", program);
  const outPath = join(dir, `${program}.ir.json`);
  const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
  if (!result.ok)
    throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
  return readFile(outPath, "utf8");
}

test("function bodies emitted in chunks merge into the text one emitter gives", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-chunked-emission-"));
  try {
    for (const program of PROGRAMS) {
      const ir = await lower(program, dir);
      const fresh = (): IrModule => deserializeModule(ir);
      for (const [name, options] of Object.entries(OPTIONS)) {
        const serial = text(emitLlvmModuleSource(fresh(), options));
        for (const functionChunks of [3, 7]) {
          const chunked = text(emitLlvmModuleSource(fresh(), { ...options, functionChunks }));
          expect(chunked === serial, `${program}, ${name}, ${functionChunks} chunks`).toBe(true);
        }
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 600_000);

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { precompiledRuntimePackTarget } from "../../compiler/src/startup-cache.js";

// The first optimized executable build of an invocation prepares its input in a frontend process
// (prepareExecutableInputInChild in the compiler's index.ts) when the compiler runs from its built
// files, as the CLI's bootstrap does. Later builds of the invocation, and builds with
// SCRIPTC_FRONTEND_PROCESS=0, prepare it in the compiler's own process.
const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../../..");
const bootstrap = join(repoRoot, "packages/cli/dist/bootstrap.js");
const compilerApi = pathToFileURL(join(repoRoot, "packages/compiler/dist/index.js")).href;
const helperTarget = precompiledRuntimePackTarget();

interface Build {
  code: number;
  stdout: string;
  stderr: string;
}

async function build(
  entry: string,
  outPath: string,
  cacheRoot: string,
  inProcess: boolean,
): Promise<Build> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SCRIPTC_CACHE_DIR: cacheRoot,
    SCRIPTC_TIMING: "1",
  };
  delete env["SCRIPTC_NO_CACHE"];
  if (inProcess) env["SCRIPTC_FRONTEND_PROCESS"] = "0";
  else delete env["SCRIPTC_FRONTEND_PROCESS"];
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [bootstrap, "build", entry, "-o", outPath],
      { env, maxBuffer: 8 * 1024 * 1024 },
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failed.code ?? 1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
  }
}

/** The build's output without its timing lines, whose times differ between runs. */
const withoutTiming = (text: string): string =>
  text
    .split("\n")
    .filter((line) => !line.startsWith("scriptc timing") && !line.startsWith("scriptc lowering"))
    .join("\n");

test.skipIf(helperTarget === null)(
  "the frontend process builds the executable, diagnostics and cache entries the in-process build does",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-frontend-process-"));
    try {
      const src = join(dir, "src");
      await mkdir(src);
      await writeFile(
        join(src, "shapes.ts"),
        "export const area = (w: number, h: number): number => w * h;\n",
      );
      await writeFile(
        join(src, "main.ts"),
        'import { area } from "./shapes.js";\nconsole.log(area(3, 4), [1, 2, 3].map((x) => x * 2).join(","));\n',
      );
      const entry = join(src, "main.ts");
      const out = (name: string): string => join(dir, name, "program");
      await mkdir(join(dir, "child"));
      await mkdir(join(dir, "inline"));

      const child = await build(entry, out("child"), join(dir, "cache-child"), false);
      const inline = await build(entry, out("inline"), join(dir, "cache-inline"), true);
      expect(child.code).toBe(0);
      expect(inline.code).toBe(0);
      expect(child.stderr).toContain('"phase":"frontend-process"');
      expect(inline.stderr).not.toContain('"phase":"frontend-process"');
      expect(await readFile(out("child"))).toEqual(await readFile(out("inline")));
      expect(await readFile(join(dir, "child", "main.ll"), "utf8")).toBe(
        await readFile(join(dir, "inline", "main.ll"), "utf8"),
      );
      expect((await execFileAsync(out("child"))).stdout).toBe("12 2,4,6\n");
      // The request and result files are removed.
      expect(
        (await readdir(join(dir, "child"))).filter((name) => name.includes("frontend")),
      ).toEqual([]);

      // A repeat finds the executable the frontend process's build published. An edit rebuilds in
      // the compiler's own process.
      const repeat = await build(entry, out("child"), join(dir, "cache-child"), false);
      expect(repeat.code).toBe(0);
      expect(repeat.stderr).not.toContain("scriptc lowering");
      expect(repeat.stderr).not.toContain('"phase":"frontend-process"');
      await writeFile(
        join(src, "shapes.ts"),
        "export const area = (w: number, h: number): number => w * h + 1;\n",
      );
      const edited = await build(entry, out("child"), join(dir, "cache-child"), false);
      expect(edited.code).toBe(0);
      expect(edited.stderr).toContain("scriptc lowering");
      expect(edited.stderr).not.toContain('"phase":"frontend-process"');
      expect((await execFileAsync(out("child"))).stdout).toBe("13 2,4,6\n");

      // Without the executable cache entries (as for a program whose frontend inputs cannot be
      // cached), the rebuild still runs in the compiler's own process: the first build recorded
      // its native program object.
      await rm(join(dir, "cache-child", "early-exe"), { recursive: true, force: true });
      await rm(join(dir, "cache-child", "early-exe-route"), { recursive: true, force: true });
      const uncached = await build(entry, out("child"), join(dir, "cache-child"), false);
      expect(uncached.code).toBe(0);
      expect(uncached.stderr).toContain("scriptc lowering");
      expect(uncached.stderr).not.toContain('"phase":"frontend-process"');
      expect((await execFileAsync(out("child"))).stdout).toBe("13 2,4,6\n");

      // A program the frontend rejects reports the same diagnostics either way. The first build of
      // the invocation in an empty cache runs the frontend process.
      await writeFile(join(src, "main.ts"), 'const n: number = "not a number";\nconsole.log(n);\n');
      const childError = await build(entry, out("child"), join(dir, "cache-child-error"), false);
      const inlineError = await build(entry, out("inline"), join(dir, "cache-inline"), true);
      expect(childError.stderr).toContain('"phase":"frontend-process"');
      expect(childError.code).not.toBe(0);
      expect(childError.code).toBe(inlineError.code);
      expect(withoutTiming(childError.stderr)).toBe(withoutTiming(inlineError.stderr));
      expect(withoutTiming(childError.stderr)).toContain("not a number");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  240_000,
);

test.skipIf(helperTarget === null)(
  "a compile called from evaluated code runs its frontend process once",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-frontend-process-eval-"));
    try {
      const entry = join(dir, "main.ts");
      await writeFile(entry, 'console.log("from eval");\n');
      const { stdout, stderr } = await execFileAsync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `import { compile } from ${JSON.stringify(compilerApi)};
           const result = await compile(process.argv[1], { outDir: process.argv[2], outPath: process.argv[3] });
           console.log("compiled", result.ok);`,
          entry,
          dir,
          join(dir, "program"),
        ],
        {
          env: { ...process.env, SCRIPTC_CACHE_DIR: join(dir, "cache"), SCRIPTC_TIMING: "1" },
          maxBuffer: 8 * 1024 * 1024,
        },
      );
      expect(stdout).toBe("compiled true\n");
      expect(stderr).toContain('"phase":"frontend-process"');
      expect((await execFileAsync(join(dir, "program"))).stdout).toBe("from eval\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  240_000,
);

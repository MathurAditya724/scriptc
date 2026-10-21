import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterEach, expect, test } from "vitest";

// The repository root supplies typescript and oxfmt to the split tools.
const root = fileURLToPath(new URL("../..", import.meta.url));
const tool = (name: string): string => join(root, "scripts/split", name);
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const compilerOptions = {
  strict: true,
  noEmit: true,
  target: "ES2022",
  module: "ESNext",
  moduleResolution: "Bundler",
};

/** A checkout holding `files` (paths relative to its root) and a tsconfig. */
function checkout(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "split-tools-"));
  dirs.push(dir);
  const all = { ...files, "tsconfig.json": JSON.stringify({ compilerOptions }) };
  for (const [path, text] of Object.entries(all)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

function run(script: string, args: string[], repo: string): void {
  execFileSync(process.execPath, [tool(script), ...args, "--repo", repo, "--tools", root], {
    cwd: repo,
    stdio: "pipe",
  });
}

/** Type errors in the checkout's files. */
function diagnostics(dir: string): string[] {
  const parsed = ts.getParsedCommandLineOfConfigFile(
    join(dir, "tsconfig.json"),
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: () => {},
    },
  );
  const program = ts.createProgram(parsed!.fileNames, parsed!.options);
  return ts
    .getPreEmitDiagnostics(program)
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
}

test("split-methods keeps an import a staying method uses as a shorthand property", () => {
  const dir = checkout({
    "src/helper.ts": "export const helper = 2;\n",
    "src/host.ts": [
      'import { helper } from "./helper.js";',
      "",
      "export class Host {",
      "  value = 1;",
      "  keep(): { helper: number } {",
      "    return { helper };",
      "  }",
      "  moved(): number {",
      "    return this.value + 1;",
      "  }",
      "}",
      "",
    ].join("\n"),
    "split.json": JSON.stringify({
      module: "src/host.ts",
      class: "Host",
      methods: { "moved.ts": ["moved"] },
    }),
  });
  run("split-methods.mjs", ["apply", join(dir, "split.json")], dir);
  expect(readFileSync(join(dir, "src/host.ts"), "utf8")).toContain(
    'import { helper } from "./helper.js";',
  );
  expect(diagnostics(dir)).toEqual([]);
});

test("split-module imports a moved class's local base class as a value", () => {
  const dir = checkout({
    "src/shapes.ts": [
      "export class Base {",
      "  x = 1;",
      "}",
      "",
      "export class Derived extends Base {",
      "  y = 2;",
      "}",
      "",
      "export function base(): Base {",
      "  return new Base();",
      "}",
      "",
    ].join("\n"),
    "split.json": JSON.stringify({
      tsconfig: "tsconfig.json",
      module: "src/shapes.ts",
      seeds: { "derived.ts": ["Derived"] },
      manifest: "manifest.json",
    }),
  });
  const config = join(dir, "split.json");
  run("split-module.mjs", ["plan", config], dir);
  run("split-module.mjs", ["apply", config], dir);
  expect(readFileSync(join(dir, "src/derived.ts"), "utf8")).toContain(
    'import { Base } from "./shapes.js";',
  );
  expect(diagnostics(dir)).toEqual([]);
});

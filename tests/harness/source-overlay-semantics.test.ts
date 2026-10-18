/* --sources: per-package semantics for source overlays. Each case builds a
 * small pnpm-shaped project whose package publishes JavaScript plus
 * declarations and whose overlay holds the upstream TypeScript, writes the
 * schema-1 manifest the way scriptc-pm would, and checks one mechanism:
 *  - `ambientDeclarations`: the package's own ambient .d.ts files type its
 *    source;
 *  - an overlay's untyped dependency compiles from its published JS;
 *  - `semanticOptions.useDefineForClassFields: false`: parameter
 *    properties are assigned before the field initializers run.
 * Without the manifest field (or before the change) each overlay falls back
 * to the published JS with a reason; with it, the package compiles from
 * source and the binary matches Node, which runs the published JS. */
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const cli = join(repoRoot, "packages/cli/dist/main.js");

interface Outcome {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(file: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv) {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      cwd,
      ...(env !== undefined ? { env } : {}),
    });
    return { code: 0, stdout, stderr } satisfies Outcome;
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), "scriptc-overlay-semantics-"));
});

afterAll(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

interface PackageSpec {
  name: string;
  /** Published files (package.json is added). */
  published: Record<string, string>;
  /** Upstream source files of the overlay. */
  source: Record<string, string>;
  /** Names of this package's dependencies (installed packages). */
  deps?: string[];
  /** Extra manifest fields for the instance. */
  manifest?: Record<string, unknown>;
}

/** A pnpm-shaped install: node_modules/.pnpm/<name>@1.0.0/node_modules/<name>,
 * a top-level link per direct dependency, and a source overlay (with its
 * node_modules link to the instance's pnpm dependency dir) for every
 * package that has a source. */
function project(label: string, main: string, direct: string[], packages: PackageSpec[]): string {
  const dir = join(root, label);
  write(join(dir, "package.json"), '{ "type": "module" }\n');
  write(
    join(dir, "tsconfig.json"),
    '{ "compilerOptions": { "target": "ES2022", "module": "ESNext", "moduleResolution": "Bundler", "strict": true, "skipLibCheck": true, "noEmit": true } }\n',
  );
  write(join(dir, "main.ts"), main);
  const pnpm = (name: string): string =>
    join(dir, "node_modules/.pnpm", `${name}@1.0.0/node_modules`);
  const instances: Record<string, unknown>[] = [];
  for (const pkg of packages) {
    const installed = join(pnpm(pkg.name), pkg.name);
    write(
      join(installed, "package.json"),
      `${JSON.stringify({ name: pkg.name, version: "1.0.0", type: "module", exports: { ".": { types: "./index.d.ts", default: "./index.js" } } })}\n`,
    );
    for (const [file, text] of Object.entries(pkg.published)) write(join(installed, file), text);
    for (const dep of pkg.deps ?? []) symlinkSync(join(pnpm(dep), dep), join(pnpm(pkg.name), dep));
    if (Object.keys(pkg.source).length === 0) continue;
    const overlay = join(dir, ".scriptc-pm/overlay", `${pkg.name}@1.0.0`, "pkg");
    const exports = { ".": { types: "./src/index.ts", default: "./src/index.ts" } };
    write(
      join(overlay, "package.json"),
      `${JSON.stringify({ name: pkg.name, version: "1.0.0", type: "module", exports })}\n`,
    );
    for (const [file, text] of Object.entries(pkg.source)) write(join(overlay, file), text);
    symlinkSync(pnpm(pkg.name), join(overlay, "node_modules"));
    instances.push({
      installedDir: installed,
      name: pkg.name,
      version: "1.0.0",
      overlayDir: overlay,
      exports,
      publishedFormat: "esm",
      semanticOptions: { useDefineForClassFields: true },
      ...pkg.manifest,
    });
  }
  for (const name of direct) {
    mkdirSync(join(dir, "node_modules"), { recursive: true });
    symlinkSync(join(pnpm(name), name), join(dir, "node_modules", name));
  }
  write(
    join(dir, ".scriptc-pm/manifest.json"),
    `${JSON.stringify({ schema: 1, generator: "source-overlay-semantics.test", lockDigest: `sha256-${label}`, instances, fallbacks: [] }, null, 2)}\n`,
  );
  return dir;
}

/** Builds main.ts with --sources and runs it beside Node (which loads the
 * published JS). */
async function buildAndRun(
  dir: string,
): Promise<{ build: Outcome; native: Outcome; node: Outcome }> {
  const build = await run(
    process.execPath,
    [cli, "build", "main.ts", "--sources", "-o", "main-bin"],
    dir,
    { ...process.env, SCRIPTC_CACHE_DIR: join(root, "cache") },
  );
  const node = await run(process.execPath, ["main.ts"], dir);
  const native =
    build.code === 0
      ? await run(join(dir, "main-bin"), [], dir)
      : { code: -1, stdout: "", stderr: "" };
  return { build, native, node };
}

const dropped = (name: string): RegExp =>
  new RegExp(
    `sources: ${name}@1\\.0\\.0 compiles from published JS \\(source overlay dropped: ([^\\n]*)`,
  );

describe("--sources overlay semantics", () => {
  test("ambientDeclarations type the overlay's source", async () => {
    const pkg = (manifest?: Record<string, unknown>): PackageSpec => ({
      name: "ambient-pkg",
      published: {
        "index.js":
          "export function greet(name) {\n  return { text: `hello ${name}`, loud: name.length > 3 };\n}\n",
        "index.d.ts":
          "export interface Greeting { text: string; loud: boolean }\nexport declare function greet(name: string): Greeting;\n",
      },
      source: {
        // Global types its build includes from typings/, never imported.
        // (The checker needs them; declaration-file shapes themselves stay
        // behind scriptc's usual .d.ts provenance fence.)
        "typings/label.d.ts": "type AmbientLabel = string;\ntype AmbientLoud = boolean;\n",
        "src/index.ts":
          "export function greet(name: AmbientLabel): { text: AmbientLabel; loud: AmbientLoud } {\n  return { text: `hello ${name}`, loud: name.length > 3 };\n}\n",
      },
      ...(manifest !== undefined ? { manifest } : {}),
    });
    const main =
      'import { greet } from "ambient-pkg";\nconst g = greet("world");\nconsole.log(g.text, g.loud);\n';

    const without = await buildAndRun(project("ambient-without", main, ["ambient-pkg"], [pkg()]));
    expect(without.build.stderr).toMatch(dropped("ambient-pkg"));
    expect(without.build.stderr.match(dropped("ambient-pkg"))![1]).toContain(
      "Cannot find name 'AmbientLabel'",
    );

    const withField = await buildAndRun(
      project(
        "ambient-with",
        main,
        ["ambient-pkg"],
        [pkg({ ambientDeclarations: ["typings/label.d.ts"] })],
      ),
    );
    expect(withField.build.stderr).not.toContain("source overlay dropped");
    expect(withField.build.code).toBe(0);
    expect(withField.native).toEqual(withField.node);
    expect(withField.node.stdout).toBe("hello world true\n");
  });

  test("an overlay's untyped dependency compiles from its published JS", async () => {
    const packages: PackageSpec[] = [
      {
        // JavaScript only, like its dependency untyped-dep, whose @types
        // package would be a devDependency of uses-untyped.
        name: "untyped-leaf",
        published: { "index.js": 'export const mark = "!";\n' },
        source: {},
      },
      {
        name: "untyped-dep",
        deps: ["untyped-leaf"],
        published: {
          "index.js":
            'import { mark } from "untyped-leaf";\nexport function shout(text) {\n  return text.toUpperCase() + mark;\n}\n',
        },
        source: {},
      },
      {
        name: "uses-untyped",
        deps: ["untyped-dep"],
        published: {
          "index.js":
            'import { shout } from "untyped-dep";\nexport function announce(name) {\n  return shout(`hi ${name}`);\n}\n',
          "index.d.ts": "export declare function announce(name: string): string;\n",
        },
        source: {
          "src/index.ts":
            'import { shout } from "untyped-dep";\n\nexport function announce(name: string): string {\n  return shout(`hi ${name}`);\n}\n',
        },
      },
    ];
    // The JavaScript-only packages have no "types": plain exports maps.
    const dir = project(
      "untyped",
      'import { announce } from "uses-untyped";\nconsole.log(announce("there"));\n',
      ["uses-untyped"],
      packages,
    );
    for (const name of ["untyped-dep", "untyped-leaf"]) {
      write(
        join(dir, `node_modules/.pnpm/${name}@1.0.0/node_modules/${name}/package.json`),
        `{ "name": "${name}", "version": "1.0.0", "type": "module", "exports": "./index.js" }\n`,
      );
    }
    const result = await buildAndRun(dir);
    expect(result.build.stderr).not.toContain("source overlay dropped");
    expect(result.build.code).toBe(0);
    expect(result.native).toEqual(result.node);
    expect(result.node.stdout).toBe("HI THERE!\n");
  });

  test("useDefineForClassFields: false assigns parameter properties before field initializers", async () => {
    // The published JS is tsc's ES2017 emit: assignments in the
    // constructor, parameter properties first.
    const published = {
      "index.js": `export class Settings {
  constructor(_options = {}) {
    this._options = _options;
    this.depth = this._options.depth ?? 1;
    this.label = this._options.label ?? "none";
  }
}
export class Entry {
  constructor(name, size) {
    this.name = name;
    this.size = size;
    this.kind = size > 0 ? "file" : "empty";
  }
}
export class Late {
}
`,
      "index.d.ts": `export interface Options { depth?: number; label?: string }
export declare class Settings { private readonly _options; readonly depth: number; readonly label: string; constructor(_options?: Options); }
export declare class Entry { name: string; size: number; kind: string; constructor(name: string, size: number); }
export declare class Late { note?: string; }
`,
    };
    const source = `export interface Options {
  depth?: number;
  label?: string;
}

export class Settings {
  public readonly depth: number = this._options.depth ?? 1;
  public readonly label: string = this._options.label ?? "none";

  constructor(private readonly _options: Options = {}) {}
}

export class Entry {
  public size: number;
  public kind: string;

  constructor(public name: string, size: number) {
    this.size = size;
    this.kind = size > 0 ? "file" : "empty";
  }
}
`;
    const main = `import { Entry, Settings } from "fields-pkg";
const settings = new Settings({ depth: 3 });
console.log(settings.depth, settings.label);
console.log(settings);
console.log(new Settings());
const entry = new Entry("a.txt", 4);
console.log(entry, Object.keys(entry).join(","));
`;
    const pkg = (useDefineForClassFields: boolean, extra = ""): PackageSpec => ({
      name: "fields-pkg",
      published,
      source: { "src/index.ts": source + extra },
      manifest: { semanticOptions: { useDefineForClassFields } },
    });

    // Define semantics (the program's): the initializer reads the
    // parameter property before it is assigned, a type error.
    const define = await buildAndRun(project("fields-define", main, ["fields-pkg"], [pkg(true)]));
    expect(define.build.stderr.match(dropped("fields-pkg"))?.[1]).toMatch(
      /SC0001 .*used before its initialization/,
    );
    expect(define.native).toEqual(define.node);

    const assign = await buildAndRun(project("fields-assign", main, ["fields-pkg"], [pkg(false)]));
    expect(assign.build.stderr).not.toContain("source overlay dropped");
    expect(assign.build.code).toBe(0);
    expect(assign.native).toEqual(assign.node);
    expect(assign.node.stdout).toContain(
      "Settings { _options: { depth: 3 }, depth: 3, label: 'none' }",
    );

    // An initializer-less field the constructor may never assign is no own
    // property under assign semantics; that shape keeps a named refusal.
    const late = await buildAndRun(
      project(
        "fields-late",
        `${main}import { Late } from "fields-pkg";\nconsole.log(new Late());\n`,
        ["fields-pkg"],
        [pkg(false, "\nexport class Late {\n  public note?: string;\n}\n")],
      ),
    );
    expect(late.build.stderr.match(dropped("fields-pkg"))?.[1]).toMatch(
      /SC1090 .*initializer-less fields the constructor does not assign/,
    );
  });
});

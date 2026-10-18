/* --sources end to end: a pnpm-installed project, upstream TypeScript for
 * three of its packages, and a schema-1 manifest that this test writes the
 * way scriptc-pm would (tests/fixtures/source-overlays holds the installed
 * tree and the upstream sources at the published commits). Every build
 * goes through the CLI so the flag, manifest discovery, fallback notes and
 * the build cache are covered as users see them. */
import { execFile } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const fixture = join(repoRoot, "tests/fixtures/source-overlays");
const cli = join(repoRoot, "packages/cli/dist/main.js");

interface OverlaySpec {
  name: string;
  version: string;
  /** pnpm's instance directory under node_modules/.pnpm. */
  instance: string;
  /** Directory under fixtures/source-overlays/sources. */
  source: string;
  repo: string;
  commit: string;
  subdir?: string;
}

const OVERLAYS: OverlaySpec[] = [
  {
    name: "path-to-regexp",
    version: "6.3.0",
    instance: "path-to-regexp@6.3.0",
    source: "path-to-regexp",
    repo: "github.com/pillarjs/path-to-regexp",
    commit: "75a92c3d7c42159f459ab42f346899152906ea8c",
  },
  {
    name: "@openfeature/server-sdk",
    version: "1.18.0",
    instance: "@openfeature+server-sdk@1.18.0_@openfeature+core@1.9.2",
    source: "server-sdk",
    repo: "github.com/open-feature/js-sdk",
    commit: "aff60f6776043bee3360053bbc76af5d95e907ae",
    subdir: "packages/server",
  },
  {
    name: "@openfeature/core",
    version: "1.9.2",
    instance: "@openfeature+core@1.9.2",
    source: "core",
    repo: "github.com/open-feature/js-sdk",
    commit: "2064d75ae097ff66f7d5e8073eb0abf711a5a3b8",
    subdir: "packages/shared",
  },
  {
    name: "mitt",
    version: "3.0.1",
    instance: "mitt@3.0.1",
    source: "mitt",
    repo: "github.com/developit/mitt",
    commit: "b240473b5707857ba2c6a8e6d707c28d1e39da49",
  },
];

/** Copies the installed project to a fresh directory outside every
 * node_modules tree and materializes `.scriptc-pm/` like scriptc-pm sync:
 * one overlay per instance (upstream source, a synthesized package.json,
 * and a node_modules link to the instance's own pnpm dependency dir) and
 * the manifest. */
function materialize(root: string): string {
  const project = join(root, "project");
  cpSync(join(fixture, "project"), project, { recursive: true, verbatimSymlinks: true });
  const instances = OVERLAYS.map((o) => {
    const pkg = join(project, ".scriptc-pm/overlay", o.instance, "pkg");
    cpSync(join(fixture, "sources", o.source), pkg, { recursive: true });
    const entry = "./src/index.ts";
    const exports = { ".": { types: entry, import: entry, require: entry, default: entry } };
    writeFileSync(
      join(pkg, "package.json"),
      `${JSON.stringify({ name: o.name, version: o.version, type: "module", exports }, null, 2)}\n`,
    );
    const pnpmDeps = join(project, "node_modules/.pnpm", o.instance, "node_modules");
    symlinkSync(pnpmDeps, join(pkg, "node_modules"));
    return {
      installedDir: join(pnpmDeps, o.name),
      name: o.name,
      version: o.version,
      overlayDir: pkg,
      exports,
      publishedFormat: "dual",
      source: {
        repo: o.repo,
        commit: o.commit,
        ...(o.subdir !== undefined ? { subdir: o.subdir } : {}),
        strategy: "fixture",
      },
      verification: { identity: "fixture", content: "unverified", surface: "unverified" },
    };
  });
  writeFileSync(
    join(project, ".scriptc-pm/manifest.json"),
    `${JSON.stringify({ schema: 1, generator: "source-overlays.test", lockDigest: "sha256-fixture", instances, fallbacks: [] }, null, 2)}\n`,
  );
  return project;
}

interface Outcome {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(
  file: string,
  args: string[] = [],
  cwd?: string,
  env?: NodeJS.ProcessEnv,
): Promise<Outcome> {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      ...(cwd !== undefined ? { cwd } : {}),
      ...(env !== undefined ? { env } : {}),
    });
    return { code: 0, stdout, stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

function scriptc(args: string[], cwd: string, cacheDir: string): Promise<Outcome> {
  return run(process.execPath, [cli, ...args], cwd, {
    ...process.env,
    SCRIPTC_CACHE_DIR: cacheDir,
    SCRIPTC_TIMING: "1",
  });
}

const cacheHit = (stderr: string): boolean => stderr.includes('"phase":"executable-cache-hit"');

let root: string;
let project: string;
let cacheDir: string;

beforeAll(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), "scriptc-sources-"));
  project = materialize(root);
  // scriptc creates the cache root itself (private, mode 0700).
  cacheDir = join(root, "cache");
});

afterAll(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

async function node(program: string, cwd = project): Promise<Outcome> {
  return run(process.execPath, [program], cwd);
}

describe("--sources", () => {
  test("path-to-regexp's parser compiles from source and matches Node; its published build does not", async () => {
    const expected = await node("routes.ts");
    expect(expected.code).toBe(0);

    // Published JS: the ES5 dist's String#concat calls compile to runtime
    // fences, so the binary diverges from Node.
    const published = await scriptc(["build", "routes.ts", "-o", "routes-pub"], project, cacheDir);
    expect(published.code).toBe(0);
    expect((await run(join(project, "routes-pub"))).stderr).toContain("SC2020");

    const first = await scriptc(
      ["build", "routes.ts", "--sources", "-o", "routes-src"],
      project,
      cacheDir,
    );
    expect(first.stderr).not.toContain("source overlay dropped");
    expect(first.code).toBe(0);
    expect(cacheHit(first.stderr)).toBe(false);
    expect(await run(join(project, "routes-src"))).toEqual(expected);

    const second = await scriptc(
      ["build", "routes.ts", "--sources", "-o", "routes-src"],
      project,
      cacheDir,
    );
    expect(second.code).toBe(0);
    expect(cacheHit(second.stderr)).toBe(true);

    // The manifest (its lock digest) is part of the cache identity.
    const manifest = JSON.parse(
      readFileSync(join(project, ".scriptc-pm/manifest.json"), "utf8"),
    ) as { lockDigest: string };
    manifest.lockDigest = "sha256-other";
    const rekeyed = join(root, "rekeyed-manifest.json");
    writeFileSync(rekeyed, JSON.stringify(manifest));
    const third = await scriptc(
      ["build", "routes.ts", `--sources=${rekeyed}`, "-o", "routes-src"],
      project,
      cacheDir,
    );
    expect(third.code).toBe(0);
    expect(cacheHit(third.stderr)).toBe(false);
    expect(await run(join(project, "routes-src"))).toEqual(expected);
  });

  test("coverage attributes overlay statements to their package", async () => {
    const coverage = await scriptc(["coverage", "routes.ts", "--sources"], project, cacheDir);
    expect(coverage.code).toBe(0);
    expect(coverage.stdout).toMatch(/path-to-regexp@6\.3\.0\s+static from source/);
    expect(coverage.stdout).toContain(
      "path-to-regexp@6.3.0  github.com/pillarjs/path-to-regexp @ 75a92c3d7c42",
    );
    expect(coverage.stdout).toMatch(/\d+ statements: \d+ static \S*\(100%\)/);
  });

  test("overlays that do not compile fall back to published JS, per package", async () => {
    // @openfeature/server-sdk@1.18.0 was built against its monorepo's core
    // sources at 1.8.0, so its source does not typecheck against the
    // installed core 1.9.2; core's own source redeclares Error#cause, which
    // lowering refuses. Both fall back, and the build is the published one.
    const withSources = await scriptc(
      ["build", "flags.ts", "--sources", "-o", "flags-src"],
      project,
      cacheDir,
    );
    expect(withSources.code).toBe(0);
    expect(withSources.stderr).toMatch(
      /sources: @openfeature\/server-sdk@1\.18\.0 compiles from published JS \(source overlay dropped: SC0001 at src\/client\/internal\/open-feature-client\.ts:\d+/,
    );
    expect(withSources.stderr).toMatch(
      /sources: @openfeature\/core@1\.9\.2 compiles from published JS \(source overlay dropped: SC1090 at src\/errors\/open-feature-error-abstract\.ts:\d+/,
    );
    const published = await scriptc(["build", "flags.ts", "-o", "flags-pub"], project, cacheDir);
    expect(published.code).toBe(0);
    expect(await run(join(project, "flags-src"))).toEqual(await run(join(project, "flags-pub")));
  });

  test("a consumer that only fails against the source surface falls back", async () => {
    // mitt's declared Emitter interface (generic overloads) does not lower
    // in the program; its published (minified) JS types by inference and
    // does. The failure is in the program, not the overlay, so the
    // published-surface probe decides.
    const expected = await node("emit.ts");
    const built = await scriptc(
      ["build", "emit.ts", "--sources", "-o", "emit-src"],
      project,
      cacheDir,
    );
    expect(built.code).toBe(0);
    expect(built.stderr).toMatch(
      /sources: mitt@3\.0\.1 compiles from published JS \(source overlay dropped: the program does not compile against its source surface \(SC2009/,
    );
    expect(await run(join(project, "emit-src"))).toEqual(expected);
  });

  test("a broken overlay and a require() edge each fall back", async () => {
    const broken = materialize(join(root, "broken"));
    appendFileSync(
      join(broken, ".scriptc-pm/overlay/path-to-regexp@6.3.0/pkg/src/index.ts"),
      '\nexport const broken: number = "not a number";\n',
    );
    const fallback = await scriptc(
      ["build", "routes.ts", "--sources", "-o", "routes-fb"],
      broken,
      cacheDir,
    );
    expect(fallback.code).toBe(0);
    expect(fallback.stderr).toMatch(
      /sources: path-to-regexp@6\.3\.0 compiles from published JS \(source overlay dropped: SC0001 at src\/index\.ts:\d+: Type 'string' is not assignable to type 'number'/,
    );
    const published = await scriptc(["build", "routes.ts", "-o", "routes-pub"], broken, cacheDir);
    expect(published.code).toBe(0);
    expect(await run(join(broken, "routes-fb"))).toEqual(await run(join(broken, "routes-pub")));

    // The published CommonJS build is what require() loads under Node, so
    // the overlay steps aside; the build then fares exactly as without it.
    const required = await scriptc(
      ["build", "require.cts", "--sources", "-o", "require-src"],
      project,
      cacheDir,
    );
    expect(required.stderr).toMatch(
      /sources: path-to-regexp@6\.3\.0 compiles from published JS \(source overlay dropped: require\(\) of 'path-to-regexp'/,
    );
    const requiredPublished = await scriptc(
      ["build", "require.cts", "-o", "require-pub"],
      project,
      cacheDir,
    );
    expect(required.code).toBe(requiredPublished.code);
  });
});

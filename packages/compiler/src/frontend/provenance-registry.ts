import { realpathSync } from "node:fs";
import { relative } from "node:path";
import { installSourceOverlays, type SourceOverlayInstance } from "./source-overlays.js";

export interface ProvenancePackageSource {
  /** Package name ("cookie"). */
  name: string;
  /** The INSTALLED published version the attestation was fetched for. */
  version: string;
  /** The version field of the source tree's package.json, when it
   * disagrees with `version` (release tooling that bumps at publish —
   * babel's shape). Informational; the differential is the real check. */
  sourceVersion?: string;
  /** The attested source repository (https URL). */
  repo: string;
  /** The attested gitCommit digest — the content address of the cached
   * source tree. */
  commit: string;
  /** Absolute path of the package's directory inside the cached source
   * tree (== the tree root except in monorepos). */
  dir: string;
  /** The installed (published) package directory the sources replace. */
  installedDir: string;
  /** specifier → absolute mapped source file ("cookie" → …/src/index.ts). */
  entries: Record<string, string>;
}

export interface ProvenanceSources {
  /** Successfully source-mapped packages, driver-import order. */
  packages: ProvenancePackageSource[];

  notes: string[];
}

/** Installs the pilot's resolved provenance sources for the current
 * compile as a source-overlay set (source-overlays.ts) — the pilot is one
 * more overlay producer, keyed like a manifest by each package's installed
 * directory. Passing null clears the overlay registry. The set never joins
 * a build cache: the pilot resolves sources from the network. */
export function setProvenanceSources(sources: ProvenanceSources | null): void {
  if (sources === null) {
    installSourceOverlays(null);
    return;
  }
  const instances: SourceOverlayInstance[] = [];
  const notes = [...sources.notes];
  for (const pkg of sources.packages) {
    const key = realDirOrNull(pkg.installedDir);
    const overlayDir = realDirOrNull(pkg.dir);
    if (key === null || overlayDir === null) {
      notes.push(`${pkg.name}: installed or source directory missing; published package used`);
      continue;
    }
    const exports: Record<string, string> = {};
    const nameLen = pkg.name.split("/").length;
    for (const [spec, file] of Object.entries(pkg.entries)) {
      const parts = spec.split("/");
      const subpath = parts.length === nameLen ? "." : `./${parts.slice(nameLen).join("/")}`;
      exports[subpath] = `./${relative(overlayDir, realpathSync(file)).split("\\").join("/")}`;
    }
    instances.push({
      key,
      name: pkg.name,
      version: pkg.version,
      overlayDir,
      exports,
      origin: `${pkg.repo
        .replace(/^git\+/, "")
        .replace(/^https:\/\//, "")
        .replace(/@refs\/.*$/, "")} @ ${pkg.commit.slice(0, 12)}`,
    });
  }
  installSourceOverlays({
    origin: "--provenance-sources",
    cacheIdentity: null,
    instances,
    notes,
  });
}

function realDirOrNull(path: string): string | null {
  try {
    return realpathSync(path).split("\\").join("/").replace(/\/+$/, "");
  } catch {
    return null;
  }
}

// The two files scriptc-pm writes: the compiler handoff manifest
// (`.scriptc-pm/manifest.json`, schema 1 of DESIGN.md §5.5) and the committed
// lock (`scriptc-sources.lock.json`, DESIGN.md §4.3).
//
// JSON.stringify follows declaration order under scriptc (and insertion order
// under Node), so every record is built field by field in the order declared
// here. That keeps the Node and native outputs byte-identical.

import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

export const GENERATOR = "scriptc-pm 0.1.0";
export const POLICY_VERSION = 1;

export type Strategy = "override" | "tarball" | "provenance" | "gitHead" | "tag";
export type Identity = "override" | "tarball" | "provenance-unverified" | "gitHead" | "tag";
export type ContentLevel = "exact" | "equivalent" | "structural" | "unverified" | "mismatch";
export type SurfaceLevel = "identical" | "drift" | "mismatch" | "unchecked";

/** condition → overlay-relative `.ts` path, per export subpath. */
export type ExportMap = Record<string, Record<string, string>>;

export interface SemanticOptions {
  useDefineForClassFields: boolean;
  experimentalDecorators: boolean;
  esModuleInterop: boolean;
}

export interface SourceRef {
  repo: string;
  commit: string;
  subdir: string;
  strategy: Strategy;
}

export interface Verification {
  identity: Identity;
  content: ContentLevel;
  surface: SurfaceLevel;
}

export interface ManifestInstance {
  installedDir: string;
  name: string;
  version: string;
  overlayDir: string;
  exports: ExportMap;
  publishedFormat: string;
  semanticOptions: SemanticOptions;
  source: SourceRef;
  verification: Verification;
}

export interface Fallback {
  name: string;
  version: string;
  reason: string;
}

export interface Manifest {
  schema: number;
  generator: string;
  lockDigest: string;
  instances: ManifestInstance[];
  fallbacks: Fallback[];
}

export interface LockEvidence {
  gitHead: string;
  provenanceCommit: string;
  tag: string;
}

export interface LockVerification {
  identity: Identity;
  content: ContentLevel;
  surface: SurfaceLevel;
  checks: string[];
}

export interface LockEntry {
  integrity: string;
  strategy: Strategy;
  evidence: LockEvidence;
  repo: string;
  commit: string;
  subdir: string;
  sourceTreeHash: string;
  entryMap: ExportMap;
  verification: LockVerification;
}

export interface Lock {
  lockfileVersion: number;
  generator: string;
  policyVersion: number;
  packages: Record<string, LockEntry>;
}

/** Serialize the lock with sorted package keys and return its digest. */
export function writeLock(projectDir: string, entries: Record<string, LockEntry>): string {
  const keys = Object.keys(entries).sort();
  const packages: Record<string, LockEntry> = {};
  for (const key of keys) {
    const entry = entries[key];
    if (entry !== undefined) packages[key] = entry;
  }
  const lock: Lock = {
    lockfileVersion: 1,
    generator: GENERATOR,
    policyVersion: POLICY_VERSION,
    packages: packages,
  };
  const text = `${JSON.stringify(lock, null, 2)}\n`;
  writeFileSync(join(projectDir, "scriptc-sources.lock.json"), text);
  return `sha256-${createHash("sha256").update(text).digest("base64")}`;
}

export function writeManifest(stateDir: string, manifest: Manifest): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

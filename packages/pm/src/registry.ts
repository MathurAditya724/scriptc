// Registry metadata: the full version document (gitHead, repository) and the
// npm provenance attestation (DESIGN.md §5.2, S2/S3). Responses are cached
// under `<cache>/meta/` so a warm sync makes no metadata requests.

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readText } from "./util.js";

export function cacheRoot(): string {
  return process.env["SCRIPTC_PM_CACHE"] ?? join(homedir(), ".cache", "scriptc-pm");
}

function registryBase(): string {
  const base = process.env["SPM_REGISTRY"] ?? "https://registry.npmjs.org";
  return base.endsWith("/") ? base.slice(0, -1) : base;
}

export interface RepoField {
  type?: string;
  url?: string;
  directory?: string;
}

interface RawVersionDoc {
  gitHead?: string;
  repository?: string | RepoField;
  dist?: { integrity?: string; attestations?: { url?: string } };
}

export interface VersionMeta {
  gitHead: string;
  repoUrl: string;
  repoDirectory: string;
  integrity: string;
  hasAttestations: boolean;
}

export interface Provenance {
  repoUrl: string;
  commit: string;
}

async function cachedFetchText(url: string, cacheFile: string): Promise<string | null> {
  const cached = readText(cacheFile);
  if (cached !== null) return cached === "" ? null : cached;
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  let text = "";
  if (res.ok) {
    text = await res.text();
  } else if (res.status !== 404) {
    throw new Error(`registry request failed (HTTP ${res.status} for ${url})`);
  }
  mkdirSync(cacheFile.slice(0, cacheFile.lastIndexOf("/")), { recursive: true });
  // A 404 is cached as an empty file: "known absent".
  writeFileSync(cacheFile, text);
  return text === "" ? null : text;
}

export async function fetchVersionMeta(name: string, version: string): Promise<VersionMeta> {
  const url = `${registryBase()}/${name}/${version}`;
  const file = join(cacheRoot(), "meta", "registry.npmjs.org", name, `${version}.json`);
  const text = await cachedFetchText(url, file);
  if (text === null) throw new Error(`registry has no version document for ${name}@${version}`);
  const doc = JSON.parse(text) as RawVersionDoc;
  let repoUrl = "";
  let repoDirectory = "";
  const repo = doc.repository;
  if (typeof repo === "string") {
    repoUrl = repo;
  } else if (repo !== undefined) {
    repoUrl = repo.url ?? "";
    repoDirectory = repo.directory ?? "";
  }
  return {
    gitHead: doc.gitHead ?? "",
    repoUrl: repoUrl,
    repoDirectory: repoDirectory,
    integrity: doc.dist?.integrity ?? "",
    hasAttestations: doc.dist?.attestations !== undefined,
  };
}

interface AttestationSet {
  attestations?: { predicateType?: string; bundle?: { dsseEnvelope?: { payload?: string } } }[];
}

interface SlsaStatement {
  subject?: { name?: string; digest?: { sha512?: string } }[];
  predicate?: {
    buildDefinition?: {
      resolvedDependencies?: { uri?: string; digest?: { gitCommit?: string } }[];
    };
  };
}

/** The SLSA provenance's source repo and commit. The Sigstore signature is
 * NOT verified (scriptc has no public-key crypto yet, DESIGN.md §7.2); the
 * subject digest is checked against the registry integrity instead, so the
 * result is recorded as `provenance-unverified`. */
export async function fetchProvenance(
  name: string,
  version: string,
  integrity: string,
): Promise<Provenance | null> {
  const url = `${registryBase()}/-/npm/v1/attestations/${name}@${version}`;
  const file = join(
    cacheRoot(),
    "meta",
    "registry.npmjs.org",
    name,
    `${version}.attestations.json`,
  );
  const text = await cachedFetchText(url, file);
  if (text === null) return null;
  const set = JSON.parse(text) as AttestationSet;
  for (const att of set.attestations ?? []) {
    if (!(att.predicateType ?? "").startsWith("https://slsa.dev/provenance")) continue;
    const payload = att.bundle?.dsseEnvelope?.payload;
    if (payload === undefined) continue;
    const stmt = JSON.parse(Buffer.from(payload, "base64").toString("utf8")) as SlsaStatement;
    if (!subjectMatches(stmt, integrity)) {
      throw new Error("provenance subject digest does not match the registry integrity");
    }
    for (const dep of stmt.predicate?.buildDefinition?.resolvedDependencies ?? []) {
      const commit = dep.digest?.gitCommit ?? "";
      const uri = dep.uri ?? "";
      if (commit !== "" && uri !== "") return { repoUrl: uri, commit: commit };
    }
  }
  return null;
}

function subjectMatches(stmt: SlsaStatement, integrity: string): boolean {
  if (!integrity.startsWith("sha512-")) return true;
  const want = Buffer.from(integrity.slice("sha512-".length), "base64").toString("hex");
  for (const subject of stmt.subject ?? []) {
    if ((subject.digest?.sha512 ?? "") === want) return true;
  }
  return false;
}

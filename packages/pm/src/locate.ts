// Source location strategies (DESIGN.md §5.2), in the POC's priority order:
// local override, source in the tarball (handled by the caller, which owns
// the published-package analysis), npm provenance, registry gitHead +
// repository, and version tags.

import type { Override } from "./config.js";
import type { Identity, LockEvidence, Strategy } from "./manifest.js";
import type { VersionMeta } from "./registry.js";
import { fetchProvenance } from "./registry.js";
import type { RepoRef } from "./repo.js";
import { parseRepoUrl } from "./repo.js";
import { baseEnv, errorMessage, run } from "./util.js";

export interface RemoteCandidate {
  strategy: Strategy;
  identity: Identity;
  repo: RepoRef;
  commit: string;
  dirHint: string;
}

export interface LocateResult {
  candidates: RemoteCandidate[];
  evidence: LockEvidence;
  /** Why no candidate was found, when `candidates` is empty. */
  notes: string[];
}

/** Every remote candidate for an instance, strongest first. All signals are
 * collected so the lock records corroboration (DESIGN.md §5.2). */
export async function locateRemote(
  name: string,
  version: string,
  meta: VersionMeta,
  override: Override | undefined,
): Promise<LocateResult> {
  const evidence: LockEvidence = { gitHead: meta.gitHead, provenanceCommit: "", tag: "" };
  const candidates: RemoteCandidate[] = [];
  const notes: string[] = [];
  if (override?.repo !== undefined) {
    const repo = parseRepoUrl(override.repo);
    if (repo !== null && override.ref !== undefined) {
      const commit = await resolveRef(repo, override.ref);
      if (commit !== "") {
        candidates.push({
          strategy: "override",
          identity: "override",
          repo: repo,
          commit: commit,
          dirHint: override.dir ?? "",
        });
      } else {
        notes.push(`override ref ${override.ref} not found`);
      }
    }
  }
  const registryRepo = parseRepoUrl(meta.repoUrl);
  if (meta.hasAttestations) {
    try {
      const prov = await fetchProvenance(name, version, meta.integrity);
      if (prov !== null) {
        evidence.provenanceCommit = prov.commit;
        const repo = parseRepoUrl(prov.repoUrl) ?? registryRepo;
        if (repo !== null) {
          candidates.push({
            strategy: "provenance",
            identity: "provenance-unverified",
            repo: repo,
            commit: prov.commit,
            dirHint: meta.repoDirectory,
          });
        }
      }
    } catch (error) {
      notes.push(`provenance: ${errorMessage(error)}`);
    }
  }
  if (registryRepo === null) {
    notes.push(
      meta.repoUrl === ""
        ? "no repository in registry metadata"
        : `unparsed repository ${meta.repoUrl}`,
    );
    return { candidates: candidates, evidence: evidence, notes: notes };
  }
  const sameAsProvenance =
    meta.gitHead === evidence.provenanceCommit &&
    candidates.some((c) => c.repo.id === registryRepo.id);
  if (meta.gitHead !== "" && !sameAsProvenance) {
    candidates.push({
      strategy: "gitHead",
      identity: "gitHead",
      repo: registryRepo,
      commit: meta.gitHead,
      dirHint: meta.repoDirectory,
    });
  }
  if (candidates.length === 0) {
    const tag = await findVersionTag(registryRepo, name, version, meta.repoDirectory);
    if (tag !== null) {
      evidence.tag = tag.name;
      candidates.push({
        strategy: "tag",
        identity: "tag",
        repo: registryRepo,
        commit: tag.commit,
        dirHint: meta.repoDirectory,
      });
    } else {
      notes.push("no gitHead, provenance or version tag");
    }
  }
  return { candidates: candidates, evidence: evidence, notes: notes };
}

interface TagHit {
  name: string;
  commit: string;
}

async function lsRemoteTags(repo: RepoRef): Promise<Map<string, string>> {
  const env = baseEnv();
  env["GIT_TERMINAL_PROMPT"] = "0";
  env["GIT_SSH_COMMAND"] = "ssh -o BatchMode=yes";
  const res = await run("git", ["ls-remote", "--tags", repo.remote], process.cwd(), env);
  const tags = new Map<string, string>();
  if (res.code !== 0) return tags;
  for (const line of res.stdout.split("\n")) {
    const [sha, ref] = line.split("\t");
    if (sha === undefined || ref === undefined || !ref.startsWith("refs/tags/")) continue;
    const tagName = ref.slice("refs/tags/".length);
    if (tagName.endsWith("^{}")) tags.set(tagName.slice(0, -3), sha);
    else if (!tags.has(tagName)) tags.set(tagName, sha);
  }
  return tags;
}

/** Conventional tags (DESIGN.md §5.2, S5); annotated tags are peeled. */
async function findVersionTag(
  repo: RepoRef,
  name: string,
  version: string,
  dir: string,
): Promise<TagHit | null> {
  const tags = await lsRemoteTags(repo);
  const unscoped = name.startsWith("@") ? (name.split("/")[1] ?? name) : name;
  const wanted = [
    `v${version}`,
    version,
    `${name}@${version}`,
    `${unscoped}@${version}`,
    `${name}-v${version}`,
    `${unscoped}-v${version}`,
  ];
  if (dir !== "") wanted.push(`${dir}/v${version}`);
  for (const tagName of wanted) {
    const commit = tags.get(tagName);
    if (commit !== undefined) return { name: tagName, commit: commit };
  }
  return null;
}

async function resolveRef(repo: RepoRef, ref: string): Promise<string> {
  if (/^[0-9a-f]{40}$/.test(ref)) return ref;
  const env = baseEnv();
  env["GIT_TERMINAL_PROMPT"] = "0";
  env["GIT_SSH_COMMAND"] = "ssh -o BatchMode=yes";
  const res = await run("git", ["ls-remote", repo.remote, ref, `${ref}^{}`], process.cwd(), env);
  if (res.code !== 0) return "";
  let commit = "";
  for (const line of res.stdout.split("\n")) {
    const [sha, name] = line.split("\t");
    if (sha === undefined || name === undefined) continue;
    if (name.endsWith("^{}") || commit === "") commit = sha;
  }
  return commit;
}

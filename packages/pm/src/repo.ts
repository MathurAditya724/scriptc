// Repository URL normalization (DESIGN.md §8.6): every form a registry or a
// provenance statement uses maps to one canonical, transport-neutral id
// (`host/owner/repo`) plus the remote git should fetch from.

export interface RepoRef {
  /** Canonical id: lowercase host, no scheme, userinfo or `.git`. */
  id: string;
  host: string;
  /** The URL handed to git. SSH remotes stay SSH. */
  remote: string;
  /** `owner/repo` for github.com, empty otherwise. */
  githubPath: string;
}

export function parseRepoUrl(raw: string): RepoRef | null {
  let url = raw.trim();
  if (url === "") return null;
  let ssh = false;
  if (url.startsWith("github:")) url = `https://github.com/${url.slice("github:".length)}`;
  else if (url.startsWith("gitlab:")) url = `https://gitlab.com/${url.slice("gitlab:".length)}`;
  else if (url.startsWith("bitbucket:")) {
    url = `https://bitbucket.org/${url.slice("bitbucket:".length)}`;
  } else if (/^[\w.-]+\/[\w.-]+$/.test(url)) url = `https://github.com/${url}`;
  if (url.startsWith("git+")) url = url.slice(4);
  // scp-like: git@host:owner/repo.git
  const scp = /^[\w.-]+@([\w.-]+):(.+)$/.exec(url);
  let host = "";
  let path = "";
  if (scp !== null) {
    ssh = true;
    host = scp[1] ?? "";
    path = scp[2] ?? "";
  } else {
    const m = /^([a-z+]+):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/.exec(url);
    if (m === null) return null;
    ssh = (m[1] ?? "") === "ssh";
    host = m[2] ?? "";
    path = m[3] ?? "";
  }
  host = host.toLowerCase();
  path = path.split("#")[0] ?? "";
  if (path.endsWith("/")) path = path.slice(0, -1);
  if (path.endsWith(".git")) path = path.slice(0, -4);
  // Browser URLs such as github.com/o/r/tree/main/packages/x keep only o/r.
  // Provenance URIs carry a ref: github.com/o/r@refs/heads/main.
  const at = path.indexOf("@");
  if (at >= 0) path = path.slice(0, at);
  const segments = path.split("/").filter((s) => s !== "");
  if (host === "github.com" && segments.length > 2) segments.length = 2;
  if (segments.length < 2) return null;
  if ((segments[segments.length - 1] as string).endsWith(".git")) {
    segments[segments.length - 1] = (segments[segments.length - 1] as string).slice(0, -4);
  }
  path = segments.join("/");
  const id = `${host}/${path}`;
  const remote = ssh ? raw.replace(/^git\+/, "") : `https://${host}/${path}.git`;
  return { id: id, host: host, remote: remote, githubPath: host === "github.com" ? path : "" };
}

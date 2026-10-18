// `spm status`: which instances were augmented and which fell back, with
// reason codes, read back from the generated manifest.

import { join } from "node:path";
import type { Manifest } from "./manifest.js";
import { readText } from "./util.js";

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

/** The reason code: the text before the first ":" ("upstream-js", ...). */
function reasonCode(reason: string): string {
  const colon = reason.indexOf(":");
  if (colon < 0) return reason;
  const code = reason.slice(0, colon);
  if (code === "not-candidate") {
    const rest = reason.slice(colon + 1).trim();
    return `not-candidate/${rest.split(/[ :(]/)[0] ?? rest}`;
  }
  return code;
}

export function status(projectDir: string, json: boolean, all: boolean): number {
  const text = readText(join(projectDir, ".scriptc-pm", "manifest.json"));
  if (text === null) {
    process.stderr.write(
      "spm: no .scriptc-pm/manifest.json; run `spm install` or `spm sync` first\n",
    );
    return 1;
  }
  const manifest = JSON.parse(text) as Manifest;
  const counts = new Map<string, number>();
  for (const f of manifest.fallbacks) {
    const code = reasonCode(f.reason);
    counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  if (json) {
    const summary: Record<string, number> = {};
    for (const code of [...counts.keys()].sort()) summary[code] = counts.get(code) ?? 0;
    const out = {
      augmented: manifest.instances.map((i) => ({
        name: i.name,
        version: i.version,
        strategy: i.source.strategy,
        identity: i.verification.identity,
        content: i.verification.content,
        surface: i.verification.surface,
      })),
      fallbacks: manifest.fallbacks
        .filter((f) => all || !f.reason.startsWith("not-candidate"))
        .map((f) => ({
          name: f.name,
          version: f.version,
          code: reasonCode(f.reason),
          reason: f.reason,
        })),
      reasonCounts: summary,
    };
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    return 0;
  }
  for (const i of manifest.instances) {
    const where =
      i.source.commit === ""
        ? i.source.strategy
        : `${i.source.repo}@${i.source.commit.slice(0, 7)}`;
    process.stdout.write(
      `augmented  ${pad(`${i.name}@${i.version}`, 46)} ${pad(where, 52)} ${pad(i.verification.identity, 22)} ` +
        `${i.verification.content}/${i.verification.surface}\n`,
    );
  }
  for (const f of manifest.fallbacks) {
    if (!all && f.reason.startsWith("not-candidate")) continue;
    process.stdout.write(`fallback   ${pad(`${f.name}@${f.version}`, 46)} ${f.reason}\n`);
  }
  const codes = [...counts.keys()].sort().map((c) => `${c}=${counts.get(c) ?? 0}`);
  process.stdout.write(
    `${manifest.instances.length} augmented, ${manifest.fallbacks.length} not augmented (${codes.join(", ")})\n`,
  );
  return 0;
}

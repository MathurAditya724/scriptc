// `scriptc-pm.json` (DESIGN.md §4.2), trimmed to what the POC implements.

import { join } from "node:path";
import { readText } from "./util.js";

export interface Override {
  /** A local checkout of the package directory. */
  path?: string;
  /** A git remote (https or ssh) plus ref and package directory. */
  repo?: string;
  ref?: string;
  dir?: string;
}

/** The minimum accepted content level (DESIGN.md §7.3). */
export type ContentPolicy = "exact" | "equivalent" | "structural" | "none";

export interface Config {
  exclude: string[];
  overrides: Record<string, Override>;
  content: ContentPolicy;
}

interface RawConfig {
  exclude?: string[];
  overrides?: Record<string, Override>;
  trust?: { content?: string };
}

export function loadConfig(projectDir: string): Config {
  const config: Config = { exclude: ["typescript"], overrides: {}, content: "equivalent" };
  const text = readText(join(projectDir, "scriptc-pm.json"));
  if (text === null) return config;
  const raw = JSON.parse(text) as RawConfig;
  if (raw.exclude !== undefined) config.exclude = raw.exclude;
  if (raw.overrides !== undefined) config.overrides = raw.overrides;
  const content = raw.trust?.content;
  if (content !== undefined) config.content = parseContentPolicy(content);
  return config;
}

export function parseContentPolicy(value: string): ContentPolicy {
  if (value === "exact" || value === "equivalent" || value === "structural" || value === "none") {
    return value;
  }
  throw new Error(`invalid content policy '${value}' (exact, equivalent, structural, none)`);
}

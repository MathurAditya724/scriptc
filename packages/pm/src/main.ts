#!/usr/bin/env node
// scriptc-pm (spm): a pnpm wrapper that augments installed npm packages with
// their verified upstream TypeScript source, for `scriptc --sources`.
//
// This program is compiled to a native binary by scriptc and also runs under
// Node; both must behave identically.

import { resolve } from "node:path";
import { loadConfig, parseContentPolicy } from "./config.js";
import type { FetchMode } from "./fetch.js";
import { GENERATOR } from "./manifest.js";
import { pnpmInstall } from "./pnpm.js";
import { status } from "./status.js";
import { sync } from "./sync.js";
import { errorMessage } from "./util.js";

const USAGE = `usage: spm <command> [options]

commands:
  install [pnpm args...]   pnpm install, then sync
  sync                     augment installed packages with upstream TypeScript
  status [--json] [--all]  augmented packages and fallbacks with reasons

sync/install options (before pnpm args):
  --dir=<path>             project (pnpm lockfile) directory (default: cwd)
  --fetch=git|codeload     source transport (default: git, codeload fallback)
  --content=<level>        minimum content level: exact|equivalent|structural|none
  --concurrency=<n>        parallel instances (default: 8)
  --verbose                also list packages that are not candidates
`;

interface Flags {
  dir: string;
  fetch: FetchMode;
  content: string;
  concurrency: number;
  verbose: boolean;
  json: boolean;
  all: boolean;
  rest: string[];
}

function parseFlags(args: string[]): Flags {
  const flags: Flags = {
    dir: process.cwd(),
    fetch: "git",
    content: "",
    concurrency: 8,
    verbose: false,
    json: false,
    all: false,
    rest: [],
  };
  let i = 0;
  for (; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg.startsWith("--dir=")) flags.dir = resolve(arg.slice("--dir=".length));
    else if (arg === "--fetch=git" || arg === "--fetch=codeload")
      flags.fetch = arg === "--fetch=git" ? "git" : "codeload";
    else if (arg.startsWith("--content=")) flags.content = arg.slice("--content=".length);
    else if (arg.startsWith("--concurrency="))
      flags.concurrency = Math.max(1, parseInt(arg.slice(14), 10) || 1);
    else if (arg === "--verbose") flags.verbose = true;
    else if (arg === "--json") flags.json = true;
    else if (arg === "--all") flags.all = true;
    else break;
  }
  for (; i < args.length; i += 1) flags.rest.push(args[i] as string);
  return flags;
}

async function runSync(flags: Flags): Promise<number> {
  const config = loadConfig(flags.dir);
  if (flags.content !== "") config.content = parseContentPolicy(flags.content);
  await sync({
    projectDir: flags.dir,
    config: config,
    fetchMode: flags.fetch,
    concurrency: flags.concurrency,
    verbose: flags.verbose,
  });
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const command = argv[0] ?? "";
  const flags = parseFlags(argv.slice(1));
  switch (command) {
    case "install": {
      const code = await pnpmInstall(flags.dir, flags.rest);
      if (code !== 0) return code;
      return runSync(flags);
    }
    case "sync":
      return runSync(flags);
    case "status":
      return status(flags.dir, flags.json, flags.all);
    case "--version":
    case "-v":
      process.stdout.write(`${GENERATOR}\n`);
      return 0;
    case "":
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(USAGE);
      return command === "" ? 1 : 0;
    default:
      process.stderr.write(`spm: unknown command '${command}'\n${USAGE}`);
      return 2;
  }
}

try {
  const code = await main(process.argv.slice(2));
  process.exitCode = code;
} catch (error) {
  process.stderr.write(`spm: ${errorMessage(error)}\n`);
  process.exitCode = 1;
}

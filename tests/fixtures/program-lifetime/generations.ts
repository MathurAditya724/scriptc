// A long-running process that replaces its program state: each generation
// builds a fresh tree of ProgramLifetime nodes (parent links make every
// subtree a reference cycle) and a symbol table, uses it, and drops it.
// Built with --program-lifetime=off, dropped generations are freed and peak
// memory stays at about one generation; with the default, every generation
// stays in memory. `--rss` appends the peak resident set size in KiB.
import { existsSync, readFileSync } from "node:fs";
import type { ProgramLifetime } from "@scriptc/types";

abstract class SyntaxNode implements ProgramLifetime {
  parent: SyntaxNode | undefined = undefined;
  readonly pos: number;
  constructor(pos: number) {
    this.pos = pos;
  }
  abstract weight(): number;
}

class Name extends SyntaxNode {
  readonly text: string;
  constructor(pos: number, text: string) {
    super(pos);
    this.text = text;
  }
  weight(): number {
    return this.text.length;
  }
}

class Block extends SyntaxNode {
  readonly children: SyntaxNode[] = [];
  add(child: SyntaxNode): void {
    child.parent = this;
    this.children.push(child);
  }
  weight(): number {
    let w = 1;
    for (const child of this.children) w += child.weight();
    return w;
  }
}

class Program implements ProgramLifetime {
  readonly root: Block;
  readonly symbols = new Map<string, Name>();
  constructor(root: Block) {
    this.root = root;
  }
}

function build(generation: number, size: number): Program {
  const program = new Program(new Block(0));
  let block = program.root;
  for (let i = 0; i < size; i++) {
    if (i % 8 === 0) {
      const next = new Block(i);
      block.add(next);
      block = i % 64 === 0 ? program.root : next;
    }
    const name = new Name(i, `g${generation}_n${i % 97}_${i}`);
    block.add(name);
    program.symbols.set(name.text, name);
  }
  return program;
}

function depth(node: SyntaxNode): number {
  let d = 0;
  for (let p = node.parent; p !== undefined; p = p.parent) d++;
  return d;
}

// Linux carries the peak RSS of the process that exec'd this one into
// getrusage, so read this process's own high-water mark where it exists.
function peakRssKb(): number {
  if (existsSync("/proc/self/status")) {
    const hwm = /VmHWM:\s*(\d+) kB/.exec(readFileSync("/proc/self/status", "utf8"));
    if (hwm !== null) return Number(hwm[1]);
  }
  return process.resourceUsage().maxRSS;
}

const generations = 300;
let checksum = 0;
for (let g = 0; g < generations; g++) {
  const program = build(g, 2000);
  const last = program.symbols.get(`g${g}_n${1999 % 97}_1999`);
  checksum = (checksum * 31 + program.root.weight() + (last ? depth(last) : -1)) % 1000003;
  if (g % 100 === 99) {
    console.log(`generation ${g + 1}: ${program.symbols.size} symbols, checksum ${checksum}`);
  }
}
console.log(`done: ${checksum}`);
if (process.argv[2] === "--rss") console.log(`maxRSS ${peakRssKb()}`);

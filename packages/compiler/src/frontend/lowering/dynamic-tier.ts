/* Hot dynamic-tier functions (SC6101, diagnostics/dynamic-tier.ts): the
 * functions of a program that compile to the dynamic tier (ir/tiers.ts) and
 * likely run often, so a build can name them. Without a profile, a function
 * counts as likely hot when a dynamic operation runs inside one of its
 * loops, when a loop calls it, or when it calls itself. Dynamic code that
 * runs once (setup code that reads an `any` configuration, for example)
 * stays quiet.
 *
 * The tier assignment is the one lowering made (Lowerer.dynamicFunctions);
 * this module ranks its functions and says why each one is dynamic, from
 * the source at its dynamic operations. A function is named only when the
 * source says why (an `any`, an untyped `JSON.parse` result, an untyped
 * JavaScript file): functions dynamic for operations without a static
 * lowering would stay dynamic with more types. */
import { relative } from "node:path";
import type { ScrDiagnostic } from "../../diagnostics/diagnostic.js";
import {
  dynamicTierDiag,
  type DynamicTierPackageCount,
  type HotReason,
  type UntypedCause,
} from "../../diagnostics/dynamic-tier.js";
import type { IrExpr, IrFunction, IrModule, IrStmt, SrcLoc } from "../../ir/ir.js";
import { dynamicOperationSites } from "../../ir/tiers.js";
import { everyStmtList } from "../../ir/traverse.js";
import * as ts from "../ts7/adapter.js";
import { isCheckedJsSourceFile, isJsSourceFile } from "../program.js";
import { isNodeModulesPath } from "../resolve.js";
import type { Lowerer } from "./lowerer.js";

export interface HotDynamicFunction {
  /** The IR function name (`%Point.norm`, `parse`, ...). */
  name: string;
  loc: SrcLoc;
  hot: HotReason;
  /** Dynamic operations inside the function's loops. */
  loopOperations: number;
  cause: UntypedCause;
}

export interface DynamicTierReport {
  /** Likely-hot dynamic functions in the program's own files, most likely
   * hot first. */
  hot: HotDynamicFunction[];
  /** Dynamic-tier functions in npm packages, by package. */
  packages: DynamicTierPackageCount[];
}

const LOOP_KINDS = new Set(["while", "doWhile", "for", "forOf"]);

function within(loc: SrcLoc, spans: readonly SrcLoc[]): boolean {
  return spans.some((s) => s.file === loc.file && s.start <= loc.start && loc.end <= s.end);
}

interface FunctionFacts {
  loops: SrcLoc[];
  /** Callee names of direct calls, with each call's location. */
  calls: { callee: string; loc: SrcLoc }[];
}

function factsOf(fn: IrFunction): FunctionFacts {
  const facts: FunctionFacts = { loops: [], calls: [] };
  everyStmtList(fn.body, {
    stmt: (s: IrStmt) => {
      if (LOOP_KINDS.has(s.kind)) facts.loops.push(s.loc);
      return true;
    },
    expr: (e: IrExpr) => {
      if (e.kind === "call") facts.calls.push({ callee: e.callee, loc: e.loc });
      return true;
    },
  });
  return facts;
}

/** The package directory name of a node_modules path (`@scope/name` or `name`). */
function packageOf(file: string): string {
  const parts = file.split("/");
  const at = parts.lastIndexOf("node_modules");
  const first = parts[at + 1] ?? "";
  return first.startsWith("@") ? `${first}/${parts[at + 2] ?? ""}` : first;
}

/** The innermost node spanning [start, end). */
function nodeAt(sf: ts.SourceFile, start: number, end: number): ts.Node {
  let node: ts.Node = sf;
  for (;;) {
    let next: ts.Node | undefined;
    ts.forEachChild(node, (child) => {
      if (ts.tokenStartOfNode(child) <= start && end <= child.end) {
        next = child;
        return true;
      }
      return undefined;
    });
    if (next === undefined) return node;
    node = next;
  }
}

/** The identifier an operand reads through (`items` in `items[i].x`). */
function rootIdentifier(node: ts.Node): ts.Identifier | null {
  let n: ts.Node = node;
  for (;;) {
    if (ts.isIdentifier(n)) return n;
    if (
      ts.isPropertyAccessExpression(n) ||
      ts.isElementAccessExpression(n) ||
      ts.isCallExpression(n)
    )
      n = n.expression;
    else if (ts.isParenthesizedExpression(n) || ts.isNonNullExpression(n)) n = n.expression;
    else return null;
  }
}

function isJsonParse(node: ts.Node | undefined): boolean {
  if (node === undefined || !ts.isCallExpression(node)) return false;
  const callee = node.expression;
  return (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === "JSON" &&
    callee.name.text === "parse"
  );
}

/** Why an identifier holds a value without a static type, or null. */
function identifierCause(lowerer: Lowerer, id: ts.Identifier, depth = 0): UntypedCause | null {
  const symbol = lowerer.checker.getSymbolAtLocation(id);
  const decl = symbol?.declarations?.[0];
  // An unannotated `for (const item of items)` variable: name `items`.
  if (
    depth < 4 &&
    decl !== undefined &&
    ts.isVariableDeclaration(decl) &&
    decl.type === undefined &&
    ts.isVariableDeclarationList(decl.parent) &&
    ts.isForOfStatement(decl.parent.parent)
  ) {
    const iterated = rootIdentifier(decl.parent.parent.expression);
    if (iterated !== null) {
      const cause = identifierCause(lowerer, iterated, depth + 1);
      if (cause !== null) return cause;
    }
  }
  if (decl !== undefined && ts.isVariableDeclaration(decl) && isJsonParse(decl.initializer))
    return { kind: "json-binding", name: id.text };
  const type = lowerer.checker.getTypeAtLocation(id);
  if ((type.flags & ts.TypeFlags.Any) !== 0) return { kind: "any", name: id.text };
  return null;
}

/** Why a node's value has no static type, or null. */
function nodeCause(lowerer: Lowerer, n: ts.Node): UntypedCause | null {
  if (isJsonParse(n)) return { kind: "json" };
  const id = rootIdentifier(n);
  return id === null ? null : identifierCause(lowerer, id);
}

/** Why the dynamic operation at `loc` has no static type, or null when
 * the source does not say. The site's own subexpressions are asked first
 * (the operand of a dynamic `for...of`), then its ancestors. */
function causeAt(lowerer: Lowerer, loc: SrcLoc): UntypedCause | null {
  const sf = lowerer.program.getSourceFile(loc.file);
  if (sf === undefined) return null;
  if (isJsSourceFile(sf) && !isCheckedJsSourceFile(sf, lowerer.projectCheckJs))
    return { kind: "javascript" };
  const node = nodeAt(sf, loc.start, loc.end);
  let found: UntypedCause | null = null;
  const descend = (n: ts.Node, depth: number): void => {
    if (found !== null || depth > 3) return;
    found = nodeCause(lowerer, n);
    if (found === null)
      ts.forEachChild(n, (child) => (descend(child, depth + 1), found !== null || undefined));
  };
  descend(node, 0);
  for (
    let n: ts.Node | undefined = node.parent;
    found === null && n !== undefined && n !== sf;
    n = n.parent
  )
    found = nodeCause(lowerer, n);
  return found;
}

/** The first cause the function's dynamic operations name, loop sites
 * first, or null when none names one. */
function causeOf(lowerer: Lowerer, sites: readonly { loc: SrcLoc }[]): UntypedCause | null {
  for (const site of sites) {
    const cause = causeAt(lowerer, site.loc);
    if (cause !== null) return cause;
  }
  return null;
}

/** The likely-hot dynamic-tier functions of `module` (see the header). */
export function scanDynamicTier(lowerer: Lowerer, module: IrModule): DynamicTierReport {
  const facts = new Map<string, FunctionFacts>();
  for (const fn of module.functions) facts.set(fn.name, factsOf(fn));
  // Functions some loop calls directly.
  const calledInLoop = new Set<string>();
  for (const fn of module.functions) {
    const f = facts.get(fn.name)!;
    for (const call of f.calls) if (within(call.loc, f.loops)) calledInLoop.add(call.callee);
  }
  const hot: HotDynamicFunction[] = [];
  const packages = new Map<string, number>();
  for (const fn of module.functions) {
    // Generated `%dyn.*` helpers are dynamic operations lowered out of line,
    // and `%init.*` is a module's top level: neither is a function to name.
    if (fn.tier !== "dynamic" || fn.name.startsWith("%dyn.") || fn.name.startsWith("%init."))
      continue;
    if (isNodeModulesPath(fn.loc.file)) {
      const name = packageOf(fn.loc.file);
      packages.set(name, (packages.get(name) ?? 0) + 1);
      continue;
    }
    const f = facts.get(fn.name)!;
    const sites = dynamicOperationSites(fn);
    const inLoops = sites.filter((s) => within(s.loc, f.loops));
    const recursive = f.calls.some((c) => c.callee === fn.name);
    const reason: HotReason | null =
      inLoops.length > 0
        ? "loop"
        : calledInLoop.has(fn.name)
          ? "called-in-loop"
          : recursive
            ? "recursive"
            : null;
    if (reason === null) continue;
    // Only functions the source makes dynamic are named: ones dynamic for
    // operations without a static lowering would stay dynamic with more types.
    const cause = causeOf(lowerer, [...inLoops, ...sites.filter((s) => !inLoops.includes(s))]);
    if (cause === null) continue;
    hot.push({
      name: fn.name,
      loc: fn.loc,
      hot: reason,
      loopOperations: inLoops.length,
      cause,
    });
  }
  const rank = { loop: 0, "called-in-loop": 1, recursive: 2 } as const;
  hot.sort((a, b) => rank[a.hot] - rank[b.hot] || b.loopOperations - a.loopOperations);
  return {
    hot,
    packages: [...packages]
      .map(([name, functions]) => ({ name, functions }))
      .sort((a, b) => b.functions - a.functions || (a.name < b.name ? -1 : 1)),
  };
}

/** `%%m144.Session.finish` → `Session.finish`, `m163.find` → `find`. */
function displayName(name: string): string {
  return name.replace(/^%+/, "").replace(/^m\d+\./, "");
}

/** SC6101 for the program lowering produced, or null (see the header).
 * Paths are relative to `root`, the entry's directory. */
export function dynamicTierWarning(
  lowerer: Lowerer,
  module: IrModule,
  root: string,
): ScrDiagnostic | null {
  const report = scanDynamicTier(lowerer, module);
  const first = report.hot[0];
  if (first === undefined) return null;
  const where = (loc: SrcLoc): string => {
    const sf = lowerer.program.getSourceFile(loc.file);
    const line = sf === undefined ? 0 : ts.getLineAndCharacterOfPosition(sf, loc.start).line + 1;
    return `${relative(root, loc.file) || loc.file}:${line}`;
  };
  return dynamicTierDiag(
    report.hot.map((f) => ({
      name: displayName(f.name),
      where: where(f.loc),
      cause: f.cause,
      hot: f.hot,
    })),
    report.packages,
    first.loc,
  );
}

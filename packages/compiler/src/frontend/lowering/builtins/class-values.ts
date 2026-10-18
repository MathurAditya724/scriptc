import * as ts from "../../ts7/adapter.js";
import { type Lowerer } from "../lowerer.js";
import { type ClassInfo } from "../lower-classes.js";
import { isJsSourceFile } from "../../program.js";
import { builtinMemberRequireDecl } from "./module-bindings.js";
import { stripTypeCasts } from "./arguments.js";
import { streamClassAliasDecl } from "../lower-stream.js";
import { zlibClassName, zlibStreamModeOf } from "./compression.js";
import { stdlibGlobalNameOf } from "../surfaces.js";

/** A builtin class an expression names at compile time: the error
 * classes, node:events EventEmitter, the node:stream classes (each a
 * runtime ClassInfo), the node:zlib stream classes (by node_zlib_mode),
 * and the Map and Set constructors. `name` is the class's `name`
 * property. */
export type BuiltinClassRef =
  | { kind: "error" | "emitter" | "stream"; info: ClassInfo; name: string }
  | { kind: "zlib"; mode: number; name: string }
  | { kind: "collection"; which: "Map" | "Set"; name: string };

/** The builtin class `expr` names: a direct spelling (`EventEmitter`,
 * `stream.Readable`, `zlib.Gzip`, `Map`, `globalThis.TypeError`) or a
 * `const` binding of one (`const E = EventEmitter`, an alias of an alias,
 * an imported alias), through parentheses and type assertions. Null for
 * anything else. */
export function builtinClassRefOf(lowerer: Lowerer, expr: ts.Expression): BuiltinClassRef | null {
  const e = stripTypeCasts(expr);
  // Checker lookups only: answering must not run the fences and deferred
  // diagnostics of a lowered reference (resolveValueSymbol).
  let symbol: ts.Symbol | undefined;
  if (ts.isIdentifier(e)) {
    symbol = lowerer.checker.getSymbolAtLocation(e);
  } else if (ts.isPropertyAccessExpression(e) && !e.questionDotToken) {
    symbol = lowerer.checker.getSymbolAtLocation(e.name);
  } else {
    return null;
  }
  if (!symbol) return null;
  const alias = builtinClassAliasOf(lowerer, symbol);
  if (alias !== null) return alias;
  if (symbol.flags & ts.SymbolFlags.Alias) symbol = lowerer.checker.getAliasedSymbol(symbol);
  const which = stdlibGlobalNameOf(lowerer, e);
  if (which === "Map" || which === "Set") return { kind: "collection", which, name: which };
  const error = lowerer.builtinErrorInfoOf(symbol);
  if (error) return { kind: "error", info: error, name: runtimeClassName(error) };
  const emitter = lowerer.builtinEmitterInfoOf(symbol);
  if (emitter) return { kind: "emitter", info: emitter, name: runtimeClassName(emitter) };
  const stream = lowerer.builtinStreamInfoOf(symbol);
  if (stream) return { kind: "stream", info: stream, name: runtimeClassName(stream) };
  const mode = zlibStreamModeOf(lowerer, symbol);
  if (mode !== null) return { kind: "zlib", mode, name: zlibClassName(mode) };
  return null;
}

/** The builtin class a `const` binding names (`const E = EventEmitter`,
 * `const M = Map`, `const C = zlib.Gzip`, or an alias of such a binding),
 * or null. `let` and `var` bindings could be reassigned, and annotated
 * bindings give the value another type, so they are not aliases. Resolved from the declaration, so uses lowered before the
 * declaration statement (hoisted functions) see the same answer. */
export function builtinClassAliasOf(lowerer: Lowerer, symbol: ts.Symbol): BuiltinClassRef | null {
  const cached = lowerer.builtinClassAliases.get(symbol);
  if (cached !== undefined) return cached;
  // An import of an exported alias names the exporting binding.
  if (symbol.flags & ts.SymbolFlags.Alias) {
    lowerer.builtinClassAliases.set(symbol, null);
    const target = lowerer.checker.getAliasedSymbol(symbol);
    const ref = target === symbol ? null : builtinClassAliasOf(lowerer, target);
    lowerer.builtinClassAliases.set(symbol, ref);
    return ref;
  }
  const init = constInitializerOf(lowerer, symbol);
  if (init === null) {
    lowerer.builtinClassAliases.set(symbol, null);
    return null;
  }
  // Marked first: a cycle through other bindings answers null.
  lowerer.builtinClassAliases.set(symbol, null);
  const ref = builtinClassRefOf(lowerer, init);
  lowerer.builtinClassAliases.set(symbol, ref);
  return ref;
}

/** True when `symbol` is a builtin class alias whose declaration owns no
 * runtime slot: new, instanceof, typeof, .name and === lower at each use,
 * and other uses report SC1090. In JavaScript files, a binding whose
 * initializer has a value (`const E = EventEmitter`, `const M =
 * globalThis.Map`, both identity tokens) keeps its slot; only builtin
 * module members (`zlib.Gzip`) and copies of slotless aliases own none.
 * The `require("events").EventEmitter` and `stream.Writable` spellings
 * keep their own declaration handling. */
export function builtinClassAliasOwnsNoSlot(lowerer: Lowerer, symbol: ts.Symbol): boolean {
  if (builtinClassAliasOf(lowerer, symbol) === null) return false;
  const binding =
    symbol.flags & ts.SymbolFlags.Alias ? lowerer.checker.getAliasedSymbol(symbol) : symbol;
  const decl = lowerer.checker.valueDeclarationOf(binding);
  if (decl === undefined || !ts.isVariableDeclaration(decl)) return false;
  if (builtinMemberRequireDecl(decl.name, decl.initializer)) return false;
  if (streamClassAliasDecl(lowerer, decl.name, decl.initializer)) return false;
  if (!isJsSourceFile(decl.getSourceFile())) return true;
  let init = decl.initializer;
  while (init !== undefined && ts.isParenthesizedExpression(init)) init = init.expression;
  if (init === undefined) return true;
  let source: ts.Symbol | undefined;
  if (ts.isPropertyAccessExpression(init)) {
    if (lowerer.builtinNamespaceModuleOf(init.expression) !== null) return true;
    source = lowerer.checker.getSymbolAtLocation(init.name);
  } else {
    source = lowerer.checker.getSymbolAtLocation(init);
  }
  return source !== undefined && builtinClassAliasOwnsNoSlot(lowerer, source);
}

/** True for a `const` declaration that is a builtin class alias owning no
 * runtime slot (see builtinClassAliasOwnsNoSlot): both declaration walks
 * skip it. */
export function registerBuiltinClassAlias(
  lowerer: Lowerer,
  nameNode: ts.Node,
  init: ts.Expression | undefined,
): boolean {
  if (!ts.isIdentifier(nameNode) || init === undefined) return false;
  const symbol = lowerer.checker.getSymbolAtLocation(nameNode);
  return symbol !== undefined && builtinClassAliasOwnsNoSlot(lowerer, symbol);
}

/** True when two references name the same builtin class. */
export function sameBuiltinClass(a: BuiltinClassRef, b: BuiltinClassRef): boolean {
  if (a.kind === "zlib") return b.kind === "zlib" && a.mode === b.mode;
  if (a.kind === "collection") return b.kind === "collection" && a.which === b.which;
  return b.kind === a.kind && b.info === a.info;
}

/** The initializer of an unannotated `const` binding whose initializer
 * can name a class (an identifier or a property access), or null. */
function constInitializerOf(lowerer: Lowerer, symbol: ts.Symbol): ts.Expression | null {
  if ((symbol.flags & ts.SymbolFlags.BlockScopedVariable) === 0) return null;
  const decl = lowerer.checker.valueDeclarationOf(symbol);
  if (
    decl === undefined ||
    !ts.isVariableDeclaration(decl) ||
    !ts.isIdentifier(decl.name) ||
    decl.type !== undefined
  ) {
    return null;
  }
  const list = decl.parent;
  if (!ts.isVariableDeclarationList(list) || (list.flags & ts.NodeFlags.Const) === 0) return null;
  let init = decl.initializer;
  while (init !== undefined && ts.isParenthesizedExpression(init)) init = init.expression;
  if (init === undefined) return null;
  if (ts.isIdentifier(init)) return init;
  if (ts.isPropertyAccessExpression(init) && !init.questionDotToken) return init;
  return null;
}

/** Node's constructor name of a runtime class (`%TypeError` → TypeError). */
function runtimeClassName(info: ClassInfo): string {
  return info.def.name.startsWith("%") ? info.def.name.slice(1) : info.def.name;
}

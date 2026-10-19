/* Bundled CommonJS chunks: esbuild wraps every CommonJS module it bundles
 * in a lazily evaluated factory,
 *
 *   var require_x = __commonJS({ "src/x.js"(exports, module) { BODY } });
 *
 * and each `require_x()` runs BODY once (later calls answer the cached
 * module.exports, a call during BODY answers the partial one). That is
 * exactly a CommonJS module that the bundle requires at the call's
 * position, so each recognized chunk becomes its own module: a virtual
 * sibling file `<bundle>.<binding>.cjs` holding BODY, its module
 * parameters respelled as the CommonJS globals, and every `require_x()`
 * call becomes `require("./<bundle>.<binding>.cjs")`. The program then
 * compiles chunks with the ordinary CommonJS machinery: evaluation at the
 * require's position, the run-once module cache, export tables, and the
 * __toESM interop erasure.
 *
 * Only shapes whose meaning is verified move: the helper must be one of
 * the recognized __commonJS spellings, every reference to a factory
 * binding must be a direct call, and BODY must not observe the
 * difference between a factory and a module (its `this`, `arguments`,
 * `__filename`, the module object beyond `module.exports`, a top-level
 * return, or a binding of the bundle other than the pure helpers copied
 * beside it). Anything else answers a degrade reason. */
import * as ts from "./ts7/syntax.js";
import { helperTokens } from "./helper-tokens.js";

export interface BundledChunkSplit {
  /** The bundle with chunk declarations blanked and calls respelled. */
  text: string;
  /** Virtual sibling modules, in declaration order. */
  chunks: { path: string; source: string }[];
}

interface Edit {
  start: number;
  end: number;
  text: string;
}

const CHUNK_SHAPE_DEGRADE =
  "its shipped JS bundles CommonJS modules through the __commonJS helper in a shape the " +
  "recognizer cannot verify";

/** The helper a counter-suffixed bundler name spells (`__commonJS2`). */
function helperBase(name: string): string {
  return /^__[A-Za-z]+\d+$/.test(name) ? name.replace(/\d+$/, "") : name;
}

function unparen(e: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  return e;
}

/** True for an identifier occurrence that reads or writes a binding (as
 * opposed to a property name, a label, or a declaration's own name).
 * Shorthand property values count: `{ x }` reads x. */
function isReference(id: ts.Identifier): boolean {
  const p = id.parent;
  if (p === undefined) return false;
  if (ts.isPropertyAccessExpression(p)) return p.expression === id;
  if (ts.isPropertyAssignment(p)) return p.initializer === id;
  if (
    ts.isMethodDeclaration(p) ||
    ts.isPropertyDeclaration(p) ||
    ts.isGetAccessorDeclaration(p) ||
    ts.isSetAccessorDeclaration(p)
  )
    return p.name !== id;
  if (ts.isBindingElement(p)) return p.initializer === id;
  if (ts.isVariableDeclaration(p) || ts.isParameter(p)) return p.initializer === id;
  if (
    ts.isFunctionDeclaration(p) ||
    ts.isFunctionExpression(p) ||
    ts.isClassDeclaration(p) ||
    ts.isClassExpression(p)
  )
    return p.name !== id;
  if (ts.isLabeledStatement(p)) return p.label !== id;
  if (ts.isBreakStatement(p) || ts.isContinueStatement(p)) return false;
  if (ts.isMetaProperty(p)) return false;
  return true;
}

/** Names a subtree declares anywhere inside it: variables (destructuring
 * included), parameters, function and class names, catch bindings. */
function declaredNames(root: ts.Node): Set<string> {
  const names = new Set<string>();
  // Binding patterns nest BindingElements, which the walk visits too.
  ts.walkPreorder(root, (n) => {
    if (n.kind >= ts.SyntaxKind.FirstJSDocNode && n.kind <= ts.SyntaxKind.LastJSDocNode)
      return "skip";
    if (ts.isVariableDeclaration(n) || ts.isParameter(n) || ts.isBindingElement(n)) {
      const name = n.name;
      if (name !== undefined && ts.isIdentifier(name)) names.add(name.text);
    } else if (
      (ts.isFunctionDeclaration(n) ||
        ts.isFunctionExpression(n) ||
        ts.isClassDeclaration(n) ||
        ts.isClassExpression(n)) &&
      n.name !== undefined
    )
      names.add(n.name.text);
    return undefined;
  });
  return names;
}

/** Every binding reference inside a subtree. */
function references(root: ts.Node): ts.Identifier[] {
  const out: ts.Identifier[] = [];
  ts.walkPreorder(root, (n) => {
    if (n.kind >= ts.SyntaxKind.FirstJSDocNode && n.kind <= ts.SyntaxKind.LastJSDocNode)
      return "skip";
    if (ts.isIdentifier(n) && isReference(n)) out.push(n);
    return undefined;
  });
  return out;
}

/** True when the reference is written (assignment target, update operand,
 * loop target, delete operand). */
function isWritten(id: ts.Identifier): boolean {
  let child: ts.Node = id;
  for (let p = child.parent; p !== undefined; child = p, p = p.parent) {
    if (ts.isBinaryExpression(p)) {
      return (
        p.left === child &&
        p.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        p.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      );
    }
    if (ts.isPrefixUnaryExpression(p) || ts.isPostfixUnaryExpression(p)) {
      return (
        p.operator === ts.SyntaxKind.PlusPlusToken || p.operator === ts.SyntaxKind.MinusMinusToken
      );
    }
    if (ts.isForInStatement(p) || ts.isForOfStatement(p)) return p.initializer === child;
    if (ts.isDeleteExpression(p)) return true;
    if (
      !(
        ts.isParenthesizedExpression(p) ||
        ts.isArrayLiteralExpression(p) ||
        ts.isObjectLiteralExpression(p) ||
        ts.isShorthandPropertyAssignment(p) ||
        ts.isPropertyAssignment(p) ||
        ts.isSpreadElement(p)
      )
    )
      return false;
  }
  return false;
}

/** The recognized __commonJS helper forms, as token templates over the
 * helper's own parameter names (CB, MOD) and the own-key reader (KEYS:
 * esbuild's `__getOwnPropNames` alias, or `Object.keys` in esbuild 0.11):
 *   keyed: `(CB, MOD) => function [name]() { return <keyed>; }` — the
 *     factory is the only method of an object literal;
 *   arrow: `(CB, MOD) => () => (<arrow>)` — the factory itself. */
const KEYED_RETURN =
  "MOD || (0, CB[KEYS(CB)[0]])((MOD = { exports: {} }).exports, MOD), MOD.exports";
const ARROW_BODY = "(MOD || CB((MOD = { exports: {} }).exports, MOD), MOD.exports)";

function template(text: string, cb: string, mod: string, keys: string): string | null {
  return helperTokens(
    text
      .replace(/\bCB\b/g, cb)
      .replace(/\bMOD\b/g, mod)
      .replace(/\bKEYS\b/g, keys),
  );
}

type HelperForm = "keyed" | "arrow";

/** The helper's form, or null when its initializer is not recognized.
 * `ownNames` answers whether an identifier names the verified
 * Object.getOwnPropertyNames alias. */
function helperForm(
  init: ts.Expression,
  sf: ts.SourceFile,
  ownNames: (name: string) => boolean,
): HelperForm | null {
  const fn = unparen(init);
  if (!ts.isArrowFunction(fn) || fn.parameters.nodes.length !== 2) return null;
  const params = fn.parameters.nodes.map((p) =>
    ts.isIdentifier(p.name) && p.initializer === undefined && p.dotDotDotToken === undefined
      ? p.name.text
      : null,
  );
  const [cb, mod] = params;
  if (cb === null || mod === null || cb === undefined || mod === undefined || cb === mod)
    return null;
  if (ts.isBlock(fn.body)) return null;
  const body = unparen(fn.body);
  if (ts.isFunctionExpression(body)) {
    if (body.parameters.nodes.length !== 0 || body.asteriskToken || body.modifiers?.nodes.length)
      return null;
    const stmts = body.body.statements.nodes;
    const ret = stmts[0];
    if (stmts.length !== 1 || ret === undefined || !ts.isReturnStatement(ret) || !ret.expression)
      return null;
    const actual = helperTokens(ret.expression.getText(sf));
    if (actual === null) return null;
    // The own-key reader: esbuild's alias or the 0.11 spelling.
    const keysRef = /\[\s*([A-Za-z_$][\w$]*(?:\.keys)?)\s*\(/.exec(ret.expression.getText(sf));
    const keys = keysRef?.[1];
    if (keys === undefined || (keys !== "Object.keys" && !ownNames(keys))) return null;
    return actual === template(KEYED_RETURN, cb, mod, keys) ? "keyed" : null;
  }
  if (ts.isArrowFunction(body) && body.parameters.nodes.length === 0 && !ts.isBlock(body.body)) {
    const actual = helperTokens(body.body.getText(sf));
    return actual !== null && actual === template(ARROW_BODY, cb, mod, "") ? "arrow" : null;
  }
  return null;
}

/** A top-level declaration the virtual chunk can copy verbatim: a pure
 * helper whose evaluation runs nothing (a function, or a member read of
 * Object such as `Object.create` / `Object.prototype.hasOwnProperty`). */
function copyableInitializer(init: ts.Expression | undefined): boolean {
  if (init === undefined) return false;
  const e = unparen(init);
  if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) return true;
  let walk: ts.Expression = e;
  let depth = 0;
  while (ts.isPropertyAccessExpression(walk) && ts.isIdentifier(walk.name)) {
    walk = walk.expression;
    depth++;
  }
  return depth > 0 && ts.isIdentifier(walk) && walk.text === "Object";
}

interface TopLevel {
  stmt: ts.Statement;
  /** The declarator (or function declaration) itself. */
  node: ts.VariableDeclaration | ts.FunctionDeclaration;
}

/** True when the file opens with a "use strict" directive prologue. */
function strictPrologue(stmts: readonly ts.Statement[]): boolean {
  for (const s of stmts) {
    if (!ts.isExpressionStatement(s) || !ts.isStringLiteral(s.expression)) return false;
    if (s.expression.text === "use strict") return true;
  }
  return false;
}

/** A cheap text probe: the helper's name, or its minified body's
 * `(m={exports:{}}).exports,m` fragment. */
export function mayBundleChunks(source: string): boolean {
  return source.includes("__commonJS") || /\{\s*exports\s*:\s*\{\s*\}\s*\}\s*\)\s*\.exports\s*,/.test(source);
}

/** Splits a CommonJS bundle's __commonJS chunks into virtual modules (see
 * the header). Null: no chunks (or not a CommonJS bundle) — serve the file
 * unchanged. */
export function splitBundledChunks(
  sf: ts.SourceFile,
  filePath: string,
): BundledChunkSplit | { degrade: string } | null {
  const source = sf.text;
  if (!mayBundleChunks(source)) return null;
  // ES-module bundles have no require: their chunks keep the existing
  // treatment (the Bun factory recognizer, or the ESM interop refusal).
  if (!filePath.endsWith(".cjs") && ts.isExternalModule(sf)) return null;

  const top = new Map<string, TopLevel>();
  const duplicate = new Set<string>();
  for (const stmt of sf.statements.nodes) {
    const add = (name: string, node: TopLevel["node"]): void => {
      if (top.has(name)) duplicate.add(name);
      else top.set(name, { stmt, node });
    };
    if (ts.isFunctionDeclaration(stmt) && stmt.name !== undefined) add(stmt.name.text, stmt);
    else if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations.nodes) {
        if (ts.isIdentifier(d.name)) add(d.name.text, d);
      }
    }
  }
  const helperNames = [...top.keys()].filter((n) => helperBase(n) === "__commonJS");

  // Every name a recognizer relies on is written nowhere and declared
  // once at the top level; `Object` itself is never rebound.
  const allRefs = references(sf);
  const written = new Set<string>();
  for (const r of allRefs) if (isWritten(r)) written.add(r.text);
  const declaredAnywhere = declaredNames(sf);
  if (declaredAnywhere.has("Object") || written.has("Object"))
    return { degrade: CHUNK_SHAPE_DEGRADE };
  const stable = (name: string): boolean => !duplicate.has(name) && !written.has(name);
  const ownNames = (name: string): boolean => {
    const t = top.get(name);
    if (t === undefined || !stable(name) || !ts.isVariableDeclaration(t.node)) return false;
    const init = t.node.initializer;
    return (
      init !== undefined &&
      helperTokens(init.getText(sf)) === helperTokens("Object.getOwnPropertyNames")
    );
  };
  if (helperNames.length === 0) {
    // The helper's shape under another name: an identifier-minified bundle,
    // whose other interop helpers lost their names as well.
    for (const [name, t] of top) {
      const init = ts.isVariableDeclaration(t.node) ? t.node.initializer : undefined;
      if (init !== undefined && stable(name) && helperForm(init, sf, ownNames) !== null)
        return {
          degrade:
            "its shipped JS is an identifier-minified bundle whose bundler-interop helpers " +
            "(__commonJS and the rest) have lost the names the recognizers verify",
        };
    }
    return null;
  }
  const forms = new Map<string, HelperForm>();
  for (const name of helperNames) {
    const t = top.get(name)!;
    const init = ts.isVariableDeclaration(t.node) ? t.node.initializer : undefined;
    const form = init !== undefined && stable(name) ? helperForm(init, sf, ownNames) : null;
    if (form === null) return { degrade: CHUNK_SHAPE_DEGRADE };
    forms.set(name, form);
  }

  // The chunk declarations: `var NAME = HELPER(factory);`, one declarator.
  interface Chunk {
    name: string;
    stmt: ts.VariableStatement;
    params: string[];
    body: ts.Block;
    path: string;
    spec: string;
  }
  const chunks = new Map<string, Chunk>();
  const base = filePath.replace(/^.*[\\/]/, "");
  for (const [name, t] of top) {
    if (!ts.isVariableDeclaration(t.node) || t.node.initializer === undefined) continue;
    const call = unparen(t.node.initializer);
    if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression)) continue;
    const form = forms.get(call.expression.text);
    if (form === undefined) continue;
    const stmt = t.stmt;
    if (
      !ts.isVariableStatement(stmt) ||
      stmt.declarationList.declarations.nodes.length !== 1 ||
      call.arguments.nodes.length !== 1 ||
      !stable(name)
    )
      return { degrade: CHUNK_SHAPE_DEGRADE };
    let factory: ts.Node = call.arguments.nodes[0]!;
    if (form === "keyed") {
      if (!ts.isObjectLiteralExpression(factory) || factory.properties.nodes.length !== 1)
        return { degrade: CHUNK_SHAPE_DEGRADE };
      factory = factory.properties.nodes[0]!;
      if (!ts.isMethodDeclaration(factory) || ts.isComputedPropertyName(factory.name))
        return { degrade: CHUNK_SHAPE_DEGRADE };
    } else {
      factory = unparen(factory as ts.Expression);
      if (!ts.isArrowFunction(factory) && !ts.isFunctionExpression(factory))
        return { degrade: CHUNK_SHAPE_DEGRADE };
    }
    const fn = factory as ts.MethodDeclaration | ts.ArrowFunction | ts.FunctionExpression;
    if (
      fn.body === undefined ||
      !ts.isBlock(fn.body) ||
      fn.asteriskToken !== undefined ||
      (fn.modifiers?.nodes.length ?? 0) > 0 ||
      fn.parameters.nodes.length > 2
    )
      return { degrade: CHUNK_SHAPE_DEGRADE };
    const params: string[] = [];
    for (const p of fn.parameters.nodes) {
      if (!ts.isIdentifier(p.name) || p.initializer !== undefined || p.dotDotDotToken)
        return { degrade: CHUNK_SHAPE_DEGRADE };
      params.push(p.name.text);
    }
    const file = `${base}.${name}.cjs`;
    chunks.set(name, {
      name,
      stmt,
      params,
      body: fn.body,
      path: filePath.slice(0, filePath.length - base.length) + file,
      spec: `./${file}`,
    });
  }
  if (chunks.size === 0) return null;

  // Every factory reference is a direct zero-argument call. Calls inside a
  // chunk body belong to that chunk's text, the rest to the bundle's.
  const callEdits: Edit[] = [];
  for (const r of allRefs) {
    const chunk = chunks.get(r.text);
    if (chunk === undefined) continue;
    const call = r.parent;
    if (
      call === undefined ||
      !ts.isCallExpression(call) ||
      call.expression !== r ||
      call.arguments.nodes.length !== 0 ||
      call.questionDotToken !== undefined
    )
      return {
        degrade: `its bundled CommonJS module factory '${r.text}' is used other than as a direct call`,
      };
    callEdits.push({
      start: call.getStart(sf),
      end: call.getEnd(),
      text: `require(${JSON.stringify(chunk.spec)})`,
    });
  }
  for (const name of chunks.keys()) {
    if (declaredAnywhere.has(name) && countDeclarations(sf, name) > 1)
      return { degrade: CHUNK_SHAPE_DEGRADE };
  }

  const bundleStrict = strictPrologue(sf.statements.nodes);
  const out: BundledChunkSplit["chunks"] = [];
  const bundleEdits: Edit[] = [...callEdits];
  for (const chunk of chunks.values()) {
    const result = chunkSource(sf, chunk, chunks, top, stable, callEdits, bundleStrict);
    if (typeof result !== "string") return result;
    out.push({ path: chunk.path, source: result });
    bundleEdits.push({ start: chunk.stmt.getStart(sf), end: chunk.stmt.getEnd(), text: "" });
  }
  return { text: applyEdits(source, 0, source.length, bundleEdits), chunks: out };
}

function countDeclarations(sf: ts.SourceFile, name: string): number {
  let n = 0;
  ts.walkPreorder(sf, (node) => {
    if (
      (ts.isVariableDeclaration(node) ||
        ts.isParameter(node) ||
        ts.isBindingElement(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isClassDeclaration(node) ||
        ts.isClassExpression(node)) &&
      node.name !== undefined &&
      ts.isIdentifier(node.name) &&
      node.name.text === name
    )
      n++;
    return undefined;
  });
  return n;
}

/** Applies non-overlapping edits inside [from, to): replaced spans keep
 * their newlines (blanked text stays line-aligned); edits nested in a
 * blanked span vanish with it. */
function applyEdits(source: string, from: number, to: number, edits: Edit[]): string {
  const inside = edits
    .filter((e) => e.start >= from && e.end <= to)
    .sort((a, b) => a.start - b.start || b.end - a.end);
  let text = "";
  let at = from;
  for (const e of inside) {
    if (e.start < at) continue; // nested in an earlier edit
    text += source.slice(at, e.start);
    const replaced = source.slice(e.start, e.end);
    // A respelled span keeps its line breaks after the replacement.
    text +=
      e.text === "" ? replaced.replace(/[^\r\n]/g, " ") : e.text + replaced.replace(/[^\n]/g, "");
    at = e.end;
  }
  return text + source.slice(at, to);
}

/** The virtual module text for one chunk, or a degrade reason. */
function chunkSource(
  sf: ts.SourceFile,
  chunk: {
    name: string;
    params: string[];
    body: ts.Block;
  },
  chunks: ReadonlyMap<string, unknown>,
  top: ReadonlyMap<string, TopLevel>,
  stable: (name: string) => boolean,
  callEdits: readonly Edit[],
  bundleStrict: boolean,
): string | { degrade: string } {
  const why = (reason: string): { degrade: string } => ({
    degrade: `its bundled CommonJS module '${chunk.name}' ${reason}`,
  });
  const [exportsParam, moduleParam] = chunk.params;
  const body = chunk.body;
  const local = declaredNames(body);
  for (const p of chunk.params) {
    if (
      local.has(p) ||
      (p !== "exports" && local.has("exports")) ||
      (p !== "module" && local.has("module"))
    )
      return why(
        "rebinds its module parameters inside its body (an identifier-minified bundle the recognizer cannot respell)",
      );
  }

  /* The factory's own frame must stay unobservable: its receiver, its
   * arguments object, and a top-level return have no module equivalent. */
  let frameUse: string | null = null;
  /** The innermost frame boundary between a node and the chunk body. */
  const frameOf = (n: ts.Node): "factory" | "arrow" | "function" => {
    let arrow = false;
    for (let p = n.parent; p !== undefined && p !== body; p = p.parent) {
      if (
        ts.isFunctionDeclaration(p) ||
        ts.isFunctionExpression(p) ||
        ts.isMethodDeclaration(p) ||
        ts.isGetAccessorDeclaration(p) ||
        ts.isSetAccessorDeclaration(p) ||
        ts.isConstructorDeclaration(p) ||
        ts.isClassDeclaration(p) ||
        ts.isClassExpression(p)
      )
        return "function";
      if (ts.isArrowFunction(p)) arrow = true;
    }
    return arrow ? "arrow" : "factory";
  };
  ts.walkPreorder(body, (n) => {
    if (frameUse !== null) return "stop";
    if (n.kind >= ts.SyntaxKind.FirstJSDocNode && n.kind <= ts.SyntaxKind.LastJSDocNode)
      return "skip";
    let use: string | null = null;
    if (n.kind === ts.SyntaxKind.ThisKeyword) use = "reads its factory's receiver (`this`)";
    else if (n.kind === ts.SyntaxKind.SuperKeyword) use = "reads `super` at its top level";
    else if (ts.isIdentifier(n) && n.text === "arguments" && isReference(n))
      use = "reads its factory's arguments object";
    else if (ts.isMetaProperty(n)) use = "reads a meta property at its top level";
    else if (ts.isReturnStatement(n)) {
      if (frameOf(n) === "factory") frameUse = "returns from its top level";
      return undefined;
    }
    if (use !== null && frameOf(n) !== "function") frameUse = use;
    return undefined;
  });
  if (frameUse !== null) return why(frameUse);

  const edits: Edit[] = callEdits.filter((e) => e.start >= body.pos && e.end <= body.end);
  const copied = new Set<string>();
  const copyQueue: string[] = [];
  for (const r of references(body)) {
    const name = r.text;
    if (chunks.has(name)) continue; // a call edit already respells it
    if (name === exportsParam || name === moduleParam) {
      if (name === moduleParam) {
        const p = r.parent;
        if (!ts.isPropertyAccessExpression(p) || p.expression !== r || p.name.text !== "exports")
          return why("uses its module object beyond module.exports");
      }
      const global = name === exportsParam ? "exports" : "module";
      if (name !== global) {
        const p = r.parent;
        edits.push(
          ts.isShorthandPropertyAssignment(p)
            ? { start: r.getStart(sf), end: r.getEnd(), text: `${name}: ${global}` }
            : { start: r.getStart(sf), end: r.getEnd(), text: global },
        );
      }
      continue;
    }
    if (local.has(name)) continue;
    if (name === "exports" || name === "module")
      return why(`reads the bundle's own '${name}' binding`);
    if (name === "__filename") return why("reads __filename, which names the bundle file");
    if (top.has(name)) {
      if (!copied.has(name)) {
        copied.add(name);
        copyQueue.push(name);
      }
    }
  }

  // The pure helpers BODY reads, closed over their own top-level reads.
  const header: string[] = [];
  for (let i = 0; i < copyQueue.length; i++) {
    const name = copyQueue[i]!;
    const t = top.get(name)!;
    const node = t.node;
    const pure =
      stable(name) &&
      (ts.isFunctionDeclaration(node) ||
        (ts.isVariableDeclaration(node) && copyableInitializer(node.initializer)));
    if (!pure || chunks.has(name))
      return why(`reads the bundle's top-level binding '${name}', which it cannot carry along`);
    const own = declaredNames(node);
    for (const r of references(node)) {
      if (own.has(r.text) || !top.has(r.text) || copied.has(r.text)) continue;
      copied.add(r.text);
      copyQueue.push(r.text);
    }
  }
  // Declaration order of the bundle: a helper reads only earlier ones.
  const ordered = [...copied].sort(
    (a, b) => top.get(a)!.node.getStart(sf) - top.get(b)!.node.getStart(sf),
  );
  for (const name of ordered) {
    const node = top.get(name)!.node;
    header.push(ts.isFunctionDeclaration(node) ? node.getText(sf) : `var ${node.getText(sf)};`);
  }

  const bodyStrict = strictPrologue(body.statements.nodes);
  const text = applyEdits(sf.text, body.getStart(sf) + 1, body.getEnd() - 1, edits);
  const prologue = bundleStrict || bodyStrict ? '"use strict";\n' : "";
  return prologue + (header.length > 0 ? header.join("\n") + "\n" : "") + text + "\n";
}

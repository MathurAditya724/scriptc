/* Static-object specialization, stage 2b (DESIGN-constant-objects.md):
 * structural rewrites of pre-module JavaScript the constant object graphs
 * prove indistinguishable.
 *
 * 1. ES5 constructors become classes. `ns.Vec = function (x, y) { … };`
 *    followed by `ns.Vec.prototype.m = function (…) { … };` statements is
 *    respelled `ns.Vec = class { constructor(x, y) { … } m(…) { … } };`.
 *    The program cannot tell the difference when:
 *    - the function is only ever constructed (every call edge is a `new`),
 *      never escapes, and its prototype is never replaced;
 *    - its prototype object is a constant object (stage 1) whose members
 *      are the function expressions those statements store, and nothing
 *      enumerates or reflects on the prototype or the instances (class
 *      methods are not enumerable, prototype assignments are);
 *    - no code reads the function's or the methods' `name` or `toString`;
 *    - the bodies behave the same in strict mode (class bodies are strict):
 *      no `arguments`, no `this` in a nested non-arrow function, no `with`,
 *      no `delete` of a name, no write to an undeclared name;
 *    - the statements between the constructor and its last method only
 *      define more functions or data (nothing runs that could observe the
 *      prototype half built).
 * 2. Namespace functions become direct functions. A constant field holding
 *    a function expression that does not use `this`, stored by a top-level
 *    statement, is hoisted to a function declaration, and calls through
 *    the namespace in the same file whose receiver is exactly that
 *    constant object call it directly.
 *
 * Each rewrite keeps the original text unless every condition holds. */
import * as ts from "../ts7/adapter.js";
import type { Atom } from "./domain.js";
import type { ShapeAnalysis } from "./analyze.js";
import { computeConstantGraphs } from "./constant-graphs.js";

type Node = ts.Node;

interface Edit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

export interface StaticObjectRewrites {
  readonly files: Map<string, string>;
  readonly classes: number;
  readonly functions: number;
  readonly directCalls: number;
  /** Candidates kept as written, with the condition that failed. */
  readonly kept: string[];
}

const REFLECTIVE_CALLS = new Set([
  "keys",
  "values",
  "entries",
  "getOwnPropertyNames",
  "getOwnPropertyDescriptor",
  "getOwnPropertyDescriptors",
  "getOwnPropertySymbols",
  "assign",
  "defineProperty",
  "defineProperties",
  "getPrototypeOf",
  "setPrototypeOf",
  "freeze",
  "seal",
  "ownKeys",
]);

function topStatement(n: Node): ts.Statement | null {
  let p: Node = n;
  while (p.parent !== undefined && !ts.isSourceFile(p.parent)) p = p.parent;
  return p.parent !== undefined && ts.isStatement(p) ? p : null;
}

/** `<lhs> = function (…) { … };` as a top-level statement: the assignment. */
function assignedFunction(fn: Node): { stmt: ts.ExpressionStatement; lhs: ts.Expression } | null {
  if (!ts.isFunctionExpression(fn) || fn.asteriskToken !== undefined) return null;
  if (fn.modifiers?.nodes.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) return null;
  const assign = fn.parent;
  if (
    assign === undefined ||
    !ts.isBinaryExpression(assign) ||
    assign.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
    assign.right !== fn
  )
    return null;
  const stmt = assign.parent;
  if (stmt === undefined || !ts.isExpressionStatement(stmt) || !ts.isSourceFile(stmt.parent))
    return null;
  return { stmt, lhs: assign.left };
}

/** Whether a function body behaves the same in strict mode. */
function strictSafe(checker: ts.TypeChecker, fn: ts.FunctionExpression): boolean {
  let safe = true;
  const visit = (n: Node, nested: boolean): void => {
    if (!safe) return;
    if (ts.isIdentifier(n) && n.text === "arguments") safe = false;
    if (n.kind === ts.SyntaxKind.WithStatement) safe = false;
    if (nested && n.kind === ts.SyntaxKind.ThisKeyword) safe = false;
    if (ts.isDeleteExpression(n) && ts.isIdentifier(n.expression)) safe = false;
    if (ts.isNumericLiteral(n) && /^0\d/.test(n.getText())) safe = false;
    if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      n.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      ts.isIdentifier(n.left)
    ) {
      let declared = false;
      try {
        const s = checker.getSymbolAtLocation(n.left);
        declared = s !== undefined && s.declarations.length > 0;
      } catch {
        declared = false;
      }
      if (!declared) safe = false;
    }
    const nestedHere = nested || (n !== fn && ts.isFunctionLike(n) && !ts.isArrowFunction(n));
    ts.forEachChild(n, (c) => visit(c, nestedHere));
  };
  visit(fn, false);
  return safe;
}

function usesThis(fn: ts.FunctionExpression): boolean {
  let found = false;
  const visit = (n: Node): void => {
    if (found) return;
    if (n.kind === ts.SyntaxKind.ThisKeyword) found = true;
    if (n !== fn && ts.isFunctionLike(n) && !ts.isArrowFunction(n)) return;
    ts.forEachChild(n, visit);
  };
  visit(fn);
  return found;
}

/** Whether a statement only defines things: function or data stores and
 * declarations whose initializers run no code outside function bodies. */
function definitionOnly(stmt: ts.Statement): boolean {
  if (ts.isFunctionDeclaration(stmt)) return true;
  let runs = false;
  const visit = (n: Node): void => {
    if (runs) return;
    if (ts.isFunctionLike(n)) return;
    if (ts.isCallExpression(n) || ts.isNewExpression(n) || ts.isTaggedTemplateExpression(n))
      runs = true;
    if (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) {
      // A read could run a getter; stores into plain paths are fine.
      const p = n.parent;
      const isStoreTarget =
        p !== undefined &&
        ts.isBinaryExpression(p) &&
        p.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        p.left === n;
      if (!isStoreTarget && !ts.isPropertyAccessExpression(p ?? n)) runs = true;
    }
    ts.forEachChild(n, visit);
  };
  if (ts.isExpressionStatement(stmt) || ts.isVariableStatement(stmt)) visit(stmt);
  else return false;
  return !runs;
}

export function planStaticObjectRewrites(
  analysis: ShapeAnalysis,
  files: readonly ts.SourceFile[],
): StaticObjectRewrites {
  const graphs = computeConstantGraphs(analysis);
  const checker = analysis.checker;
  const kept: string[] = [];
  const editsByFile = new Map<ts.SourceFile, Edit[]>();
  const fileSet = new Set(files);
  const edit = (sf: ts.SourceFile, e: Edit): void => {
    let l = editsByFile.get(sf);
    if (l === undefined) editsByFile.set(sf, (l = []));
    l.push(e);
  };
  const constantAtoms = new Map<Atom, (typeof graphs.objects)[number]>();
  for (const o of graphs.objects) constantAtoms.set(o.site.atom, o);

  // Program-wide facts the conditions read.
  const readNames = new Map<Atom, Set<string>>();
  for (const op of analysis.ops) {
    if (op.kind !== "read" || op.name === null) continue;
    for (const a of analysis.nodes[op.recv]!.atoms) {
      let s = readNames.get(a);
      if (s === undefined) readNames.set(a, (s = new Set()));
      s.add(op.name);
    }
  }
  const computedRecv = new Set<Atom>();
  for (const op of analysis.ops)
    if (op.kind !== "read" && op.kind !== "write" && op.kind !== "lengthWrite")
      for (const a of analysis.nodes[op.recv]!.atoms) computedRecv.add(a);
  const forIns: ts.Expression[] = [];
  const reflective: ts.CallExpression[] = [];
  for (const sf of analysis.files) {
    const visit = (n: Node): void => {
      if (ts.isForInStatement(n)) forIns.push(n.expression);
      if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        ts.isIdentifier(n.expression.name) &&
        (REFLECTIVE_CALLS.has(n.expression.name.text) ||
          n.expression.name.text === "propertyIsEnumerable")
      )
        reflective.push(n);
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  const declOf = (id: ts.Identifier): Node | undefined => {
    try {
      const s = checker.getSymbolAtLocation(id);
      return s?.valueDeclaration ?? s?.declarations[0];
    } catch {
      return undefined;
    }
  };
  /** Whether an expression may evaluate to one of `atoms` (identifiers
   * through their declarations' values, `new` of a known constructor path;
   * anything else may). */
  const mayBe = (e: ts.Expression, atoms: ReadonlySet<Atom>, ctorPath: string): boolean => {
    while (ts.isParenthesizedExpression(e)) e = e.expression;
    if (ts.isNewExpression(e)) {
      if (e.expression.getText() === ctorPath)
        return [...atoms].some((a) => a.label.startsWith("new "));
      return false;
    }
    if (ts.isIdentifier(e)) {
      const d = declOf(e);
      if (d === undefined) return true;
      for (const a of analysis.declValues(d)) if (atoms.has(a)) return true;
      return false;
    }
    if (
      ts.isLiteralExpression(e) ||
      ts.isObjectLiteralExpression(e) ||
      ts.isArrayLiteralExpression(e)
    )
      return false;
    return true;
  };
  /** Whether a reflective call may reach one of `atoms`. */
  const reflectsOn = (atoms: ReadonlySet<Atom>, ctorPath: string): boolean =>
    reflective.some((call) => call.arguments.nodes.some((arg) => mayBe(arg, atoms, ctorPath)));
  const enumerates = (atoms: ReadonlySet<Atom>, ctorPath: string): boolean =>
    forIns.some((e) => mayBe(e, atoms, ctorPath));
  const noNameOrSource = (a: Atom): boolean => {
    const names = readNames.get(a);
    return names === undefined || (!names.has("name") && !names.has("toString"));
  };

  const hoisted = new Map<Atom, string>();
  const used = new Set<string>();
  for (const sf of files) for (const m of sf.text.matchAll(/[A-Za-z_$][\w$]*/g)) used.add(m[0]);
  const classPlans: {
    sf: ts.SourceFile;
    site: { stmt: ts.ExpressionStatement; lhs: ts.Expression };
    fn: ts.FunctionExpression;
    methods: { name: string; fn: ts.FunctionExpression; stmt: ts.ExpressionStatement }[];
    fnAtom: Atom;
  }[] = [];
  // ── 1. constructors to classes ──────────────────────────────────────
  let classes = 0;
  const instanceOf = new Map<Node, Atom[]>();
  for (const a of analysis.atoms.atoms)
    if (a.kind === "object" && a.node !== undefined && a.label.startsWith("new ")) {
      let l = instanceOf.get(a.node);
      if (l === undefined) instanceOf.set(a.node, (l = []));
      l.push(a);
    }
  const escapedFns = new Set<Node>([...analysis.escapedFunctions].map((f) => f.node));
  for (const [fnAtom, proto] of analysis.protoOf) {
    const fnNode = fnAtom.node;
    if (fnNode === undefined) continue;
    const sf = fnNode.getSourceFile();
    if (!fileSet.has(sf)) continue;
    const label = `${fnAtom.label}`;
    const keep = (why: string): void => {
      kept.push(`class ${label}: ${why}`);
    };
    const site = assignedFunction(fnNode);
    if (site === null) {
      keep("not a function expression stored by a top-level statement");
      continue;
    }
    const protoObject = constantAtoms.get(proto);
    if (protoObject === undefined) {
      keep("prototype is not a constant object");
      continue;
    }
    if (analysis.escaped.has(fnAtom) || escapedFns.has(fnNode)) {
      keep("escapes");
      continue;
    }
    const edges = analysis.calls.filter((e) => e.callee.node === fnNode);
    if (edges.some((e) => !ts.isNewExpression(e.site))) {
      keep("called without new");
      continue;
    }
    const assigned = analysis.fields.get(fnAtom)?.get("prototype");
    if (assigned !== undefined && analysis.nodes[assigned]!.atoms.size > 0) {
      keep("prototype replaced");
      continue;
    }
    const instances = instanceOf.get(fnNode) ?? [];
    const watched = new Set<Atom>([proto, fnAtom, ...instances]);
    if (instances.some((i) => analysis.escaped.has(i))) {
      keep("an instance escapes");
      continue;
    }
    // Instances enumerate inherited members only through for-in; own-key
    // reflection (Object.keys, assign, JSON) sees the same either way. The
    // prototype and the function itself must not be reflected on at all.
    const ctorPath = site.lhs.getText();
    const definitional = new Set<Atom>([proto, fnAtom]);
    if (
      [...watched].some((a) => computedRecv.has(a)) ||
      enumerates(watched, ctorPath) ||
      reflectsOn(definitional, ctorPath)
    ) {
      keep("enumeration or reflection may reach the prototype or instances");
      continue;
    }
    if (!noNameOrSource(fnAtom)) {
      keep("reads name or toString");
      continue;
    }
    if (!strictSafe(checker, fnNode as ts.FunctionExpression)) {
      keep("constructor body is not strict-mode safe");
      continue;
    }
    // The methods: one statement per prototype member, in this file.
    const methods: { name: string; fn: ts.FunctionExpression; stmt: ts.ExpressionStatement }[] = [];
    let ok = true;
    for (const f of protoObject.fields) {
      if (f.key === "constructor") continue;
      if (f.values.length !== 1 || f.values[0]!.kind !== "function" || f.stores !== 1) {
        ok = false;
        break;
      }
      const m = f.values[0]!;
      const mNode = m.node;
      const ms = mNode === undefined ? null : assignedFunction(mNode);
      if (
        ms === null ||
        mNode!.getSourceFile() !== sf ||
        !ts.isPropertyAccessExpression(ms.lhs) ||
        !ts.isPropertyAccessExpression(ms.lhs.expression) ||
        ms.lhs.expression.name.text !== "prototype" ||
        ms.lhs.expression.expression.getText() !== site.lhs.getText() ||
        (mNode as ts.FunctionExpression).name !== undefined ||
        !strictSafe(checker, mNode as ts.FunctionExpression) ||
        !noNameOrSource(m) ||
        !/^[A-Za-z_$][\w$]*$/.test(f.key) ||
        f.key === "constructor"
      ) {
        ok = false;
        break;
      }
      methods.push({ name: f.key, fn: mNode as ts.FunctionExpression, stmt: ms.stmt });
    }
    if (!ok) {
      keep("a prototype member is not a plain method stored by a top-level statement");
      continue;
    }
    // Only definitions between the constructor and its last method.
    const stmts = sf.statements.nodes;
    const first = stmts.indexOf(site.stmt);
    const last = Math.max(first, ...methods.map((m) => stmts.indexOf(m.stmt)));
    const methodStmts = new Set<ts.Statement>(methods.map((m) => m.stmt));
    if (methods.some((m) => stmts.indexOf(m.stmt) < first)) {
      keep("a method is stored before the constructor");
      continue;
    }
    let between = true;
    for (let i = first + 1; i < last; i++)
      if (!methodStmts.has(stmts[i]!) && !definitionOnly(stmts[i]!)) between = false;
    if (!between) {
      keep("code runs between the constructor and its methods");
      continue;
    }
    classPlans.push({ sf, site, fn: fnNode as ts.FunctionExpression, methods, fnAtom });
    classes++;
  }

  for (const plan of classPlans) {
    const base = `__ns_${plan.site.lhs.getText().replace(/[^\w$]/g, "_")}`;
    let name = base;
    for (let i = 1; used.has(name); i++) name = `${base}_${i}`;
    used.add(name);
    hoisted.set(plan.fnAtom, name);
  }
  const callEdits: { sf: ts.SourceFile; edit: Edit }[] = [];
  const hoists: {
    sf: ts.SourceFile;
    stmt: ts.Statement;
    name: string;
    fn: ts.FunctionExpression;
  }[] = [];
  // ── 2. namespace functions to direct functions ─────────────────────
  let functions = 0;
  let directCalls = 0;
  for (const o of graphs.objects) {
    if (o.site.kind === "prototype") continue;
    for (const f of o.fields) {
      if (f.values.length !== 1 || f.values[0]!.kind !== "function" || f.stores !== 1) continue;
      const fnAtom = f.values[0]!;
      const fnNode = fnAtom.node;
      if (fnNode === undefined || analysis.protoOf.has(fnAtom)) continue;
      const site = assignedFunction(fnNode);
      if (site === null || !fileSet.has(fnNode.getSourceFile())) continue;
      const fn = fnNode as ts.FunctionExpression;
      if (fn.name !== undefined || usesThis(fn) || !noNameOrSource(fnAtom)) continue;
      const sf = fnNode.getSourceFile();
      const base = `__ns_${site.lhs.getText().replace(/[^\w$]/g, "_")}`;
      let name = base;
      for (let i = 1; used.has(name); i++) name = `${base}_${i}`;
      used.add(name);
      hoisted.set(fnAtom, name);
      edit(sf, {
        start: ts.tokenStartOfNode(fn),
        end: fn.end,
        text: name,
      });
      hoists.push({ sf, stmt: site.stmt, name, fn });
      functions++;
    }
  }
  // Direct references: `e.k` (called, constructed or read) in the same file
  // whose receiver is exactly the constant object holding a hoisted
  // function or class.
  for (const op of analysis.ops) {
    if (op.kind !== "read" || op.name === null) continue;
    const atoms = analysis.nodes[op.recv]!.atoms;
    if (atoms.size !== 1) continue;
    const recv = [...atoms][0]!;
    const o = constantAtoms.get(recv);
    if (o === undefined) continue;
    const field = o.fields.find((f) => f.key === op.name);
    if (field === undefined || field.values.length !== 1) continue;
    const name = hoisted.get(field.values[0]!);
    if (name === undefined) continue;
    const node = op.node;
    // Any read of the member: a callee, a `new` target, an `instanceof`
    // operand or a plain value (the binding holds the same function).
    const parent = node.parent;
    if (parent === undefined || ts.isDeleteExpression(parent)) continue;
    if (node.getSourceFile() !== field.values[0]!.node!.getSourceFile()) continue;
    if (!ts.isPropertyAccessExpression(node)) continue;
    if (topStatement(node) === null) continue;
    callEdits.push({
      sf: node.getSourceFile(),
      edit: { start: ts.tokenStartOfNode(node), end: node.end, text: name },
    });
    directCalls++;
  }

  // Text of a node with the direct calls inside it applied.
  const sliceWithCalls = (sf: ts.SourceFile, n: Node): string => {
    const from = ts.tokenStartOfNode(n);
    const inner = callEdits
      .filter((c) => c.sf === sf && c.edit.start >= from && c.edit.end <= n.end)
      .map((c) => c.edit)
      .sort((a, b) => a.start - b.start);
    let out = "";
    let at = from;
    for (const e of inner) {
      out += sf.text.slice(at, e.start) + e.text;
      at = e.end;
    }
    return out + sf.text.slice(at, n.end);
  };
  for (const h of hoists) {
    const params = h.fn.parameters.nodes
      .map((p) => h.sf.text.slice(ts.tokenStartOfNode(p), p.end))
      .join(", ");
    edit(h.sf, {
      start: ts.tokenStartOfNode(h.stmt),
      end: ts.tokenStartOfNode(h.stmt),
      text: `function ${h.name}(${params}) ${sliceWithCalls(h.sf, h.fn.body)}\n`,
    });
  }

  // Classes: a declaration at the constructor's statement, then the store.
  for (const plan of classPlans) {
    const { sf, site, fn, methods, fnAtom } = plan;
    const name = hoisted.get(fnAtom)!;
    const text = (n: Node): string => sliceWithCalls(sf, n);
    const params = (f: ts.FunctionExpression): string =>
      f.parameters.nodes.map((p) => text(p)).join(", ");
    const body = [
      `class ${name} {`,
      ` constructor(${params(fn)}) ${text(fn.body)}`,
      ...methods.map((m) => ` ${m.name}(${params(m.fn)}) ${text(m.fn.body)}`),
      `}`,
      "",
    ].join("\n");
    edit(sf, {
      start: ts.tokenStartOfNode(site.stmt),
      end: ts.tokenStartOfNode(site.stmt),
      text: body,
    });
    edit(sf, { start: ts.tokenStartOfNode(fn), end: fn.end, text: name });
    for (const m of methods)
      edit(sf, { start: ts.tokenStartOfNode(m.stmt), end: m.stmt.end, text: "" });
  }

  for (const c of callEdits) edit(c.sf, c.edit);
  const out = new Map<string, string>();
  for (const [sf, edits] of editsByFile) out.set(sf.fileName, applyEdits(sf.text, edits));
  return { files: out, classes, functions, directCalls, kept };
}

/** Applies replacements and insertions; an edit inside an earlier
 * replacement is applied to the replaced text (nested edits move with the
 * text they sit in). */
function applyEdits(text: string, edits: readonly Edit[]): string {
  const sorted = [...edits].sort((a, b) => a.start - b.start || b.end - a.end);
  const apply = (from: number, to: number, list: Edit[]): string => {
    let out = "";
    let at = from;
    for (let i = 0; i < list.length; i++) {
      const e = list[i]!;
      if (e.start < at) continue;
      out += text.slice(at, e.start);
      if (e.end > e.start) {
        // Edits nested inside this replacement whose text is not literal:
        // a replacement that rebuilds its range from source pieces applies
        // them only through its own text, so nested edits are dropped here.
        out += e.text;
        at = e.end;
      } else {
        out += e.text;
        at = e.start;
      }
    }
    return out + text.slice(at, to);
  };
  return apply(0, text.length, sorted);
}

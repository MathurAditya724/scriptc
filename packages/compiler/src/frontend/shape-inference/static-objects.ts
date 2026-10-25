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
 *      no `arguments`, `eval` or strict-mode reserved word, no `this` in a
 *      nested non-arrow function, no `with`, no `delete` of a name, no write
 *      to an undeclared name or to `undefined`, `NaN` or `Infinity`, no
 *      repeated parameter name, no octal literal or escape, and property
 *      writes and deletes only through `this` (a write that sloppy mode
 *      ignores, into a primitive or a frozen object, throws in strict mode);
 *    - nothing freezes, seals or redefines the instances, so their own
 *      properties stay writable;
 *    - each method is only called as a method (`x.m(…)`): never constructed,
 *      read as a value or for its `prototype`, so it is never called with a
 *      primitive or missing `this` (which sloppy mode would replace) and
 *      never needs to be constructible (class methods are not);
 *    - a named constructor expression does not refer to its own name, which
 *      the class would not bind;
 *    - the statements between the constructor and its last method only
 *      define more functions or data (nothing runs that could observe the
 *      prototype half built): their stores go to constant objects, which
 *      have no setters;
 *    - nothing asks the prototype whether its members are enumerable
 *      (`propertyIsEnumerable`).
 * 2. Namespace functions become direct functions. A constant field holding
 *    a function expression that does not use `this`, stored by a top-level
 *    statement, is hoisted to a function declaration, and calls through
 *    the namespace in the same file whose receiver is exactly that
 *    constant object call it directly. A member read is replaced only when
 *    its receiver is an initialized name or a chain of constant-object reads
 *    from one (nothing to evaluate, nothing to throw), and it runs after the
 *    store: in a top-level statement after it, or inside the stored
 *    function, and not inside a function declaration (which hoisting lets
 *    run earlier). A name is initialized when it is a parameter, a function
 *    declaration, or a variable declared with an initializer by an earlier
 *    top-level statement and never assigned again.
 *
 * Each rewrite keeps the original text unless every condition holds. */
import * as ts from "../ts7/adapter.js";
import type { Atom } from "./domain.js";
import type { ShapeAnalysis } from "./analyze.js";
import { computeConstantGraphs } from "./constant-graphs.js";
import { resolveCjsRuntime } from "../cjs-resolve.js";

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
  /** Calls through constant function tables dispatched directly. */
  readonly tableDispatches: number;
  /** Reads of constant primitive members replaced by their literal. */
  readonly foldedReads: number;
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
  "preventExtensions",
  "ownKeys",
]);

/** The most members a dispatched function table may have. */
const MAX_TABLE_ARMS = 16;

/** Words that are reserved only in strict mode. */
const STRICT_RESERVED = new Set([
  "implements",
  "interface",
  "let",
  "package",
  "private",
  "protected",
  "public",
  "static",
  "yield",
  "eval",
]);

/** The reflective calls that freeze, seal or redefine an object. */
const RESHAPING_CALLS = new Set([
  "freeze",
  "seal",
  "preventExtensions",
  "defineProperty",
  "defineProperties",
  "setPrototypeOf",
]);

/** Globals that sloppy mode lets a write to fail silently. */
const READ_ONLY_GLOBALS = new Set(["undefined", "NaN", "Infinity"]);

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

/** A function expression stored as a member of an object literal that a
 * top-level statement creates (`ns.registry = { run: function () {} }`,
 * `var ns = { util: { trim: function () {} } }`, at any literal depth): the
 * statement, and a dotted path naming the member. The function's scope is
 * the module scope, so it can be hoisted to a module function. */
function literalMemberFunction(fn: Node): { stmt: ts.Statement; path: string } | null {
  if (!ts.isFunctionExpression(fn) || fn.asteriskToken !== undefined) return null;
  if (fn.modifiers?.nodes.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) return null;
  const keys: string[] = [];
  let n: Node = fn;
  for (;;) {
    const member = n.parent;
    if (member === undefined || !ts.isPropertyAssignment(member) || member.initializer !== n)
      return null;
    const name = member.name;
    if (!ts.isIdentifier(name) && !ts.isStringLiteral(name)) return null;
    keys.unshift(name.text);
    const literal = member.parent;
    if (literal === undefined || !ts.isObjectLiteralExpression(literal)) return null;
    const holder = literal.parent;
    if (holder !== undefined && ts.isPropertyAssignment(holder)) {
      n = literal;
      continue;
    }
    if (
      holder !== undefined &&
      ts.isBinaryExpression(holder) &&
      holder.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      holder.right === literal &&
      holder.parent !== undefined &&
      ts.isExpressionStatement(holder.parent) &&
      ts.isSourceFile(holder.parent.parent)
    )
      return { stmt: holder.parent, path: [holder.left.getText(), ...keys].join(".") };
    if (
      holder !== undefined &&
      ts.isVariableDeclaration(holder) &&
      holder.initializer === literal &&
      ts.isIdentifier(holder.name)
    ) {
      const stmt = holder.parent?.parent;
      if (stmt !== undefined && ts.isVariableStatement(stmt) && ts.isSourceFile(stmt.parent))
        return { stmt, path: [holder.name.text, ...keys].join(".") };
    }
    return null;
  }
}

/** The text of a primitive literal an object literal itself gives `key`
 * (`{ K: 1 }`, `{ "k": "v" }`, `-1`, `true`, `null`), or null. */
function ownLiteralMember(literal: Node, key: string): string | null {
  // `__proto__: v` in a literal sets the prototype and makes no property.
  if (!ts.isObjectLiteralExpression(literal) || key === "__proto__") return null;
  let found: string | null = null;
  for (const m of literal.properties.nodes) {
    const name = (m as { name?: Node }).name;
    const text =
      name !== undefined && (ts.isIdentifier(name) || ts.isStringLiteral(name)) ? name.text : null;
    if (text !== key) continue;
    if (!ts.isPropertyAssignment(m) || found !== null) return null;
    found = primitiveLiteralText(m.initializer);
    if (found === null) return null;
  }
  return found;
}

function primitiveLiteralText(e: ts.Expression): string | null {
  if (
    ts.isNumericLiteral(e) ||
    ts.isStringLiteral(e) ||
    e.kind === ts.SyntaxKind.TrueKeyword ||
    e.kind === ts.SyntaxKind.FalseKeyword ||
    e.kind === ts.SyntaxKind.NullKeyword
  )
    return e.getText();
  if (
    ts.isPrefixUnaryExpression(e) &&
    e.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(e.operand)
  )
    return e.getText();
  return null;
}

/** Whether a member expression only reads: not a store target, not
 * updated, deleted or called. */
function isPlainRead(node: ts.Expression): boolean {
  const p = node.parent;
  if (p === undefined) return false;
  if (
    ts.isBinaryExpression(p) &&
    p.left === node &&
    p.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    p.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  )
    return false;
  if (ts.isPrefixUnaryExpression(p) || ts.isPostfixUnaryExpression(p)) {
    const op = p.operator;
    if (op === ts.SyntaxKind.PlusPlusToken || op === ts.SyntaxKind.MinusMinusToken) return false;
  }
  if (ts.isDeleteExpression(p)) return false;
  if ((ts.isCallExpression(p) || ts.isNewExpression(p)) && p.expression === node) return false;
  // Destructuring and for-in/of targets.
  if (ts.isArrayLiteralExpression(p) || ts.isShorthandPropertyAssignment(p)) return false;
  if ((ts.isForInStatement(p) || ts.isForOfStatement(p)) && p.initializer === node) return false;
  if (
    ts.isPropertyAssignment(p) &&
    p.initializer === node &&
    ts.isObjectLiteralExpression(p.parent!)
  ) {
    // `({ a: x.k } = …)`: a target only inside an assignment pattern.
    let q: Node | undefined = p.parent;
    while (
      q !== undefined &&
      (ts.isObjectLiteralExpression(q) ||
        ts.isArrayLiteralExpression(q) ||
        ts.isPropertyAssignment(q) ||
        ts.isParenthesizedExpression(q))
    ) {
      const up: Node | undefined = q.parent;
      if (up !== undefined && ts.isBinaryExpression(up) && up.left === q) return false;
      q = up;
    }
  }
  return true;
}

/** Whether `e` is a property access or element access through `this`. */
function throughThis(e: ts.Expression): boolean {
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  return (
    (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) &&
    e.expression.kind === ts.SyntaxKind.ThisKeyword
  );
}

/** Whether a function body behaves the same in strict mode. */
function strictSafe(checker: ts.TypeChecker, fn: ts.FunctionExpression): boolean {
  let safe = true;
  // A repeated parameter name is a strict-mode error.
  const params = new Set<string>();
  for (const p of fn.parameters.nodes) {
    if (!ts.isIdentifier(p.name) || params.has(p.name.text)) return false;
    params.add(p.name.text);
  }
  const visit = (n: Node, nested: boolean): void => {
    if (!safe) return;
    if (ts.isIdentifier(n) && (n.text === "arguments" || STRICT_RESERVED.has(n.text))) safe = false;
    if (n.kind === ts.SyntaxKind.WithStatement) safe = false;
    if (nested && n.kind === ts.SyntaxKind.ThisKeyword) safe = false;
    if (ts.isDeleteExpression(n) && !throughThis(n.expression)) safe = false;
    if (ts.isNumericLiteral(n) && /^0\d/.test(n.getText())) safe = false;
    // Octal escapes in strings and templates are strict-mode errors.
    if (
      (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) &&
      /\\(0\d|[1-7])/.test(n.getText())
    )
      safe = false;
    const assigns =
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      n.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
    const counts =
      (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) &&
      (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken);
    const target = assigns
      ? (n as ts.BinaryExpression).left
      : counts
        ? (n as ts.PrefixUnaryExpression).operand
        : undefined;
    // A store that sloppy mode drops (into a primitive, a frozen object or a
    // read-only property) throws in strict mode: only stores through `this`,
    // a fresh or method receiver object, are known to behave the same.
    if (target !== undefined) {
      let t = target;
      while (ts.isParenthesizedExpression(t)) t = t.expression;
      if ((ts.isPropertyAccessExpression(t) || ts.isElementAccessExpression(t)) && !throughThis(t))
        safe = false;
      if (ts.isIdentifier(t) && READ_ONLY_GLOBALS.has(t.text)) safe = false;
      if (
        !ts.isIdentifier(t) &&
        !ts.isPropertyAccessExpression(t) &&
        !ts.isElementAccessExpression(t)
      )
        safe = false;
    }
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

/** Whether an identifier named `name` appears in `fn`'s parameters or body. */
function mentions(fn: ts.FunctionExpression, name: string): boolean {
  let found = false;
  const visit = (n: Node): void => {
    if (found) return;
    if (ts.isIdentifier(n) && n.text === name && n !== fn.name) found = true;
    ts.forEachChild(n, visit);
  };
  visit(fn);
  return found;
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
  // One entry per (kind, syntax node): a node the analysis walked in
  // several contexts (receiver classes, per-site clones) is rewritten only
  // when the receivers of every context together satisfy the conditions.
  const mergedOps: { op: (typeof analysis.ops)[number]; atoms: Set<Atom> }[] = [];
  {
    const byKey = new Map<string, { op: (typeof analysis.ops)[number]; atoms: Set<Atom> }>();
    const ids = new Map<Node, number>();
    for (const op of analysis.ops) {
      let id = ids.get(op.node);
      if (id === undefined) ids.set(op.node, (id = ids.size));
      const key = `${op.kind}:${op.name ?? ""}:${id}`;
      let entry = byKey.get(key);
      if (entry === undefined) {
        byKey.set(key, (entry = { op, atoms: new Set() }));
        mergedOps.push(entry);
      }
      for (const a of analysis.nodes[op.recv]!.atoms) entry.atoms.add(a);
    }
  }
  const forIns: ts.Expression[] = [];
  const reflective: ts.CallExpression[] = [];
  // Receivers of `x.propertyIsEnumerable(…)` calls, and whether the method
  // is also reached any other way (`.call`, a stored reference).
  const enumerabilityQueries: ts.Expression[] = [];
  let enumerabilityEscapes = false;
  // Names stored to by assignments or updates.
  const assignedNames: ts.Identifier[] = [];
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
      if (ts.isIdentifier(n) && n.text === "propertyIsEnumerable") {
        const access = n.parent;
        const call = access?.parent;
        if (
          access !== undefined &&
          ts.isPropertyAccessExpression(access) &&
          access.name === n &&
          call !== undefined &&
          ts.isCallExpression(call) &&
          call.expression === access
        )
          enumerabilityQueries.push(access.expression);
        else enumerabilityEscapes = true;
      }
      if (
        ts.isBinaryExpression(n) &&
        n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        n.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
        ts.isIdentifier(n.left)
      )
        assignedNames.push(n.left);
      if (
        (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) &&
        (n.operator === ts.SyntaxKind.PlusPlusToken ||
          n.operator === ts.SyntaxKind.MinusMinusToken) &&
        ts.isIdentifier(n.operand)
      )
        assignedNames.push(n.operand);
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
  const readOps = new Map<Node, (typeof analysis.ops)[number]>();
  const writeOps = new Map<Node, (typeof analysis.ops)[number]>();
  for (const op of analysis.ops) {
    if (op.kind === "read") readOps.set(op.node, op);
    if (op.kind === "write") writeOps.set(op.node, op);
  }
  const reassigned = new Set<Node>();
  for (const id of assignedNames) {
    const d = declOf(id);
    if (d !== undefined) reassigned.add(d);
  }
  /** Whether evaluating `e` runs no code, so a rewrite that no longer
   * evaluates it changes nothing: a name, `this`, or a member read whose
   * receiver is such an expression and can only be constant objects (they
   * have no accessors). A call, an assignment or any other expression may
   * have effects. */
  const effectFree = (e: ts.Expression): boolean => {
    while (ts.isParenthesizedExpression(e)) e = e.expression;
    if (ts.isIdentifier(e) || e.kind === ts.SyntaxKind.ThisKeyword) return true;
    let receiver: ts.Expression;
    if (ts.isPropertyAccessExpression(e) && e.questionDotToken === undefined)
      receiver = e.expression;
    else if (
      ts.isElementAccessExpression(e) &&
      e.questionDotToken === undefined &&
      ts.isStringLiteralLike(e.argumentExpression)
    )
      receiver = e.expression;
    else return false;
    const op = readOps.get(e);
    if (op === undefined) return false;
    const atoms = analysis.nodes[op.recv]!.atoms;
    if (atoms.size === 0 || ![...atoms].every((a) => constantAtoms.has(a))) return false;
    return effectFree(receiver);
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
  /** `mayBe`, which also follows member reads: a constructor's `prototype`
   * is its default prototype object, and a constant object's field holds
   * the values stored to it. */
  const mayBeValue = (e: ts.Expression, atoms: ReadonlySet<Atom>, ctorPath: string): boolean => {
    while (ts.isParenthesizedExpression(e)) e = e.expression;
    if (!ts.isPropertyAccessExpression(e)) return mayBe(e, atoms, ctorPath);
    const op = readOps.get(e);
    if (op === undefined || op.name === null) return true;
    for (const a of analysis.nodes[op.recv]!.atoms) {
      const proto = op.name === "prototype" ? analysis.protoOf.get(a) : undefined;
      if (proto !== undefined) {
        if (atoms.has(proto)) return true;
        continue;
      }
      if (!constantAtoms.has(a)) return true;
      const field = analysis.fields.get(a)?.get(op.name);
      if (field !== undefined && [...analysis.nodes[field]!.atoms].some((v) => atoms.has(v)))
        return true;
    }
    return false;
  };
  /** Whether a reflective call may reach one of `atoms`: as an argument, or
   * as the object `propertyIsEnumerable` is asked about. */
  const reflectsOn = (atoms: ReadonlySet<Atom>, ctorPath: string): boolean =>
    enumerabilityEscapes ||
    enumerabilityQueries.some((recv) => mayBeValue(recv, atoms, ctorPath)) ||
    reflective.some((call) => call.arguments.nodes.some((arg) => mayBe(arg, atoms, ctorPath)));
  /** Whether a call that freezes, seals or redefines an object may reach one of `atoms`. */
  const reshapes = (atoms: ReadonlySet<Atom>, ctorPath: string): boolean =>
    reflective.some(
      (call) =>
        RESHAPING_CALLS.has((call.expression as ts.PropertyAccessExpression).name.getText()) &&
        call.arguments.nodes.some((arg) => mayBe(arg, atoms, ctorPath)),
    );
  /** The reads of each member name, for the method checks. */
  const readsOf = new Map<string, { node: Node; recv: ReadonlySet<Atom> }[]>();
  for (const op of analysis.ops) {
    if (op.kind !== "read" || op.name === null) continue;
    let l = readsOf.get(op.name);
    if (l === undefined) readsOf.set(op.name, (l = []));
    l.push({ node: op.node, recv: analysis.nodes[op.recv]!.atoms });
  }
  /** Whether every read of member `key` through one of `atoms` is the callee of a call. */
  const onlyCalled = (key: string, atoms: ReadonlySet<Atom>): boolean =>
    (readsOf.get(key) ?? []).every(({ node, recv }) => {
      if (![...recv].some((a) => atoms.has(a))) return true;
      const parent = node.parent;
      return parent !== undefined && ts.isCallExpression(parent) && parent.expression === node;
    });
  const enumerates = (atoms: ReadonlySet<Atom>, ctorPath: string): boolean =>
    forIns.some((e) => mayBe(e, atoms, ctorPath));
  const noNameOrSource = (a: Atom): boolean => {
    const names = readNames.get(a);
    return names === undefined || (!names.has("name") && !names.has("toString"));
  };

  /** Whether `node` runs only after the top-level statement `stmt` has run:
   * in a later top-level statement, and not in a function declaration
   * (which hoisting lets run earlier). */
  const afterStatement = (node: Node, stmt: ts.Statement): boolean => {
    for (let p: Node | undefined = node.parent; p !== undefined; p = p.parent)
      if (ts.isFunctionDeclaration(p)) return false;
    const top = topStatement(node);
    if (top === null) return false;
    const stmts = node.getSourceFile().statements.nodes;
    return stmts.indexOf(top) > stmts.indexOf(stmt);
  };
  /** Whether the binding `id` names holds its value whenever `at` runs: a
   * parameter or a function declaration, or a variable declared with an
   * initializer by an earlier top-level statement of the same file. None is
   * ever assigned again. A variable read earlier is undefined, or throws in
   * its temporal dead zone. */
  const initializedAt = (id: ts.Identifier, at: Node): boolean => {
    const d = declOf(id);
    if (d === undefined || reassigned.has(d)) return false;
    if (ts.isParameter(d) || ts.isFunctionDeclaration(d)) return true;
    if (!ts.isVariableDeclaration(d) || d.initializer === undefined) return false;
    const stmt = d.parent?.parent;
    if (stmt === undefined || !ts.isVariableStatement(stmt) || !ts.isSourceFile(stmt.parent))
      return false;
    return stmt.parent === at.getSourceFile() && afterStatement(at, stmt);
  };
  /** Whether evaluating `e` where `at` runs runs nothing and cannot throw: an
   * initialized name, or a chain of member reads from constant objects
   * (plain data) starting at one. */
  const pureReceiver = (e: ts.Expression, at: Node): boolean => {
    while (ts.isParenthesizedExpression(e)) e = e.expression;
    if (ts.isIdentifier(e)) return initializedAt(e, at);
    if (!ts.isPropertyAccessExpression(e)) return false;
    const op = readOps.get(e);
    if (op === undefined) return false;
    const recv = analysis.nodes[op.recv]!.atoms;
    if (recv.size !== 1 || !constantAtoms.has([...recv][0]!)) return false;
    return pureReceiver(e.expression, at);
  };
  /** Whether a store to `target` runs no code: its receiver is a constant
   * object, which has no setters, reached without running anything, and the
   * key is not `__proto__`, which Object.prototype stores through a setter. */
  const inertStore = (target: ts.Expression): boolean => {
    if (!ts.isPropertyAccessExpression(target) || !ts.isIdentifier(target.name)) return false;
    if (target.name.text === "__proto__") return false;
    const op = writeOps.get(target);
    if (op === undefined) return false;
    const recv = analysis.nodes[op.recv]!.atoms;
    if (recv.size !== 1 || !constantAtoms.has([...recv][0]!)) return false;
    return pureReceiver(target.expression, target);
  };
  /** Whether a statement only defines things: function declarations, and
   * declarations and stores whose evaluation runs no code outside function
   * bodies (no call, no read that could run a getter, no store that could run
   * a setter). */
  const definitionOnly = (stmt: ts.Statement): boolean => {
    if (ts.isFunctionDeclaration(stmt)) return true;
    if (!ts.isExpressionStatement(stmt) && !ts.isVariableStatement(stmt)) return false;
    let runs = false;
    const visit = (n: Node): void => {
      if (runs) return;
      if (ts.isFunctionLike(n)) return;
      if (ts.isCallExpression(n) || ts.isNewExpression(n) || ts.isTaggedTemplateExpression(n))
        runs = true;
      if (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) {
        const p = n.parent;
        const isStoreTarget =
          p !== undefined &&
          ts.isBinaryExpression(p) &&
          p.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          p.left === n;
        if (isStoreTarget) {
          if (!inertStore(n)) runs = true;
          return;
        }
        // A read could run a getter; the receivers of reads are part of them.
        if (!ts.isPropertyAccessExpression(p ?? n)) runs = true;
      }
      ts.forEachChild(n, visit);
    };
    visit(stmt);
    return !runs;
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
    // A frozen, sealed or redefined instance turns the stores that sloppy
    // mode drops into strict-mode TypeErrors.
    if (reshapes(watched, ctorPath)) {
      keep("an instance may be frozen, sealed or redefined");
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
    // A named function expression binds its name in its own body; the
    // class is declared under another name.
    const ownName = (fnNode as ts.FunctionExpression).name;
    if (ownName !== undefined && mentions(fnNode as ts.FunctionExpression, ownName.text)) {
      keep("a named constructor refers to its own name");
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
      // Only ever called as a method: a class method is not constructible,
      // has no `prototype`, and a strict-mode call keeps a primitive or
      // missing `this` where sloppy mode would replace it.
      const calledAsMethod = analysis.calls
        .filter((e) => e.callee.node === mNode)
        .every(
          (e) =>
            ts.isCallExpression(e.site) &&
            ts.isPropertyAccessExpression(e.site.expression) &&
            e.site.expression.name.getText() === f.key,
        );
      if (
        analysis.escaped.has(m) ||
        escapedFns.has(mNode!) ||
        !calledAsMethod ||
        !onlyCalled(f.key, watched)
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

  // The statement each hoisted class is declared at (before it).
  const classStatements = new Map<string, ts.Statement>();
  // The statement that stores each hoisted function or class, and the
  // function itself: a read of the member runs after the store when it is
  // inside that function or in a later top-level statement.
  const storeOf = new Map<Atom, { stmt: ts.Statement; fn: Node }>();
  for (const plan of classPlans) {
    const base = `__ns_${plan.site.lhs.getText().replace(/[^\w$]/g, "_")}`;
    let name = base;
    for (let i = 1; used.has(name); i++) name = `${base}_${i}`;
    used.add(name);
    hoisted.set(plan.fnAtom, name);
    classStatements.set(name, plan.site.stmt);
    storeOf.set(plan.fnAtom, { stmt: plan.site.stmt, fn: plan.fn });
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
  let tableDispatches = 0;
  for (const o of graphs.objects) {
    if (o.site.kind === "prototype") continue;
    for (const f of o.fields) {
      if (f.values.length !== 1 || f.values[0]!.kind !== "function" || f.stores !== 1) continue;
      const fnAtom = f.values[0]!;
      const fnNode = fnAtom.node;
      if (fnNode === undefined || analysis.protoOf.has(fnAtom)) continue;
      const assigned = assignedFunction(fnNode);
      // Also members of object literals a top-level statement creates.
      const site =
        assigned !== null
          ? { stmt: assigned.stmt as ts.Statement, path: assigned.lhs.getText() }
          : literalMemberFunction(fnNode);
      if (site === null || !fileSet.has(fnNode.getSourceFile())) continue;
      const fn = fnNode as ts.FunctionExpression;
      if (fn.name !== undefined || usesThis(fn) || !noNameOrSource(fnAtom)) continue;
      const sf = fnNode.getSourceFile();
      const base = `__ns_${site.path.replace(/[^\w$]/g, "_")}`;
      let name = base;
      for (let i = 1; used.has(name); i++) name = `${base}_${i}`;
      used.add(name);
      hoisted.set(fnAtom, name);
      storeOf.set(fnAtom, { stmt: site.stmt, fn });
      edit(sf, {
        start: ts.tokenStartOfNode(fn),
        end: fn.end,
        text: name,
      });
      hoists.push({ sf, stmt: site.stmt, name, fn });
      functions++;
    }
  }
  // ── cross-file references ──────────────────────────────────────────
  // A read in another file of a constant namespace member that is a
  // hoisted function or class refers to it through the defining module's
  // exports: the overlay adds the binding to the module's exports literal
  // (`module.exports = { app, __ns_app_run: __ns_app_run }`) and the
  // reading file binds the module once, right after the top-level
  // statement that requires it (`const __ns_mod_0 = require("lib");`).
  // The added members are unobservable when the exports object is a
  // constant object nothing enumerates, reflects on, or lets escape; the
  // module is loaded by then, so the extra require only returns it; and
  // the defining module must not require the reading file (a cycle could
  // run the reading file's code before the module finished).
  const exportLiterals = new Map<ts.SourceFile, ts.ObjectLiteralExpression | null>();
  const exportLiteralOf = (sf: ts.SourceFile): ts.ObjectLiteralExpression | null => {
    if (exportLiterals.has(sf)) return exportLiterals.get(sf)!;
    let found: ts.ObjectLiteralExpression | null = null;
    for (const st of sf.statements.nodes) {
      if (!ts.isExpressionStatement(st) || !ts.isBinaryExpression(st.expression)) continue;
      const b = st.expression;
      if (
        b.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        b.left.getText() === "module.exports" &&
        ts.isObjectLiteralExpression(b.right)
      )
        found = found === null ? b.right : null;
    }
    if (found !== null) {
      const o = graphs.objects.find((x) => x.site.node === found);
      const atoms = new Set<Atom>(o === undefined ? [] : [o.site.atom]);
      if (
        o === undefined ||
        analysis.escaped.has(o.site.atom) ||
        computedRecv.has(o.site.atom) ||
        enumerates(atoms, "") ||
        reflectsOn(atoms, "")
      )
        found = null;
    }
    exportLiterals.set(sf, found);
    return found;
  };
  const filesByName = new Map<string, ts.SourceFile>();
  for (const f of analysis.files) filesByName.set(f.fileName, f);
  /** The program file `require(lit)` in `sf` loads: the checker's module,
   * else the file Node's resolver finds (the checker resolves only some
   * require forms), or null. */
  const requireTarget = (sf: ts.SourceFile, lit: ts.StringLiteral): ts.SourceFile | null => {
    let target: Node | undefined;
    try {
      target = checker.getSymbolAtLocation(lit)?.declarations[0];
    } catch {
      target = undefined;
    }
    if (target !== undefined && ts.isSourceFile(target)) return target;
    const resolved = resolveCjsRuntime(sf.fileName, lit.text);
    return resolved.ok ? (filesByName.get(resolved.value) ?? null) : null;
  };
  const requiredFiles = (sf: ts.SourceFile, node: Node): ts.SourceFile[] => {
    const out: ts.SourceFile[] = [];
    const visit = (n: Node): void => {
      if (
        ts.isCallExpression(n) &&
        ts.isIdentifier(n.expression) &&
        n.expression.text === "require" &&
        n.arguments.nodes.length === 1 &&
        ts.isStringLiteral(n.arguments.nodes[0]!)
      ) {
        const target = requireTarget(sf, n.arguments.nodes[0] as ts.StringLiteral);
        if (target !== null) out.push(target);
      }
      ts.forEachChild(n, visit);
    };
    visit(node);
    return out;
  };
  /** The files `sf` requires, directly or through the files they require. */
  const requireClosures = new Map<ts.SourceFile, Set<ts.SourceFile>>();
  const requiredClosure = (sf: ts.SourceFile): Set<ts.SourceFile> => {
    let seen = requireClosures.get(sf);
    if (seen !== undefined) return seen;
    seen = new Set();
    const work = [sf];
    while (work.length > 0) {
      const f = work.pop()!;
      for (const t of requiredFiles(f, f))
        if (!seen.has(t)) {
          seen.add(t);
          work.push(t);
        }
    }
    requireClosures.set(sf, seen);
    return seen;
  };
  /** Whether a top-level statement requires `target` each time it runs:
   * the statement is `require(…)`, an assignment of it, or declarations
   * one of which it initializes, optionally followed by member reads. A
   * require inside a function, a condition or another expression runs only
   * when that does. */
  /** The values a top-level statement computes: its declarations'
   * initializers, or its expression (an assignment's right side). */
  const statementValues = (st: ts.Statement): ts.Expression[] | null => {
    if (ts.isVariableStatement(st))
      return st.declarationList.declarations.nodes.flatMap((d) =>
        d.initializer !== undefined ? [d.initializer] : [],
      );
    if (!ts.isExpressionStatement(st)) return null;
    const e = st.expression;
    return [
      ts.isBinaryExpression(e) &&
      e.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(e.left)
        ? e.right
        : e,
    ];
  };
  /** The require call `v` is, followed by member reads, or null. */
  const requireValue = (v: ts.Expression): ts.CallExpression | null => {
    let e = v;
    for (;;) {
      if (ts.isParenthesizedExpression(e)) e = e.expression;
      else if (ts.isPropertyAccessExpression(e) && e.questionDotToken === undefined)
        e = e.expression;
      else break;
    }
    return ts.isCallExpression(e) &&
      ts.isIdentifier(e.expression) &&
      e.expression.text === "require"
      ? e
      : null;
  };
  const requiresWhenRun = (sf: ts.SourceFile, st: ts.Statement, target: ts.SourceFile): boolean =>
    (statementValues(st) ?? []).some((v) => {
      const call = requireValue(v);
      return call !== null && requiredFiles(sf, call).includes(target);
    });
  /** Whether `node` sits inside a function of its top-level statement. */
  const insideFunction = (node: Node): boolean => {
    const top = topStatement(node);
    for (let p: Node | undefined = node.parent; p !== undefined && p !== top; p = p.parent)
      if (ts.isFunctionLike(p)) return true;
    return false;
  };
  /** The nodes whose statements must have run for an effect-free receiver
   * (effectFree) to be the constant object it reads as: each member read's
   * stores of that member, and a name's declaration. */
  const receiverDeps = (e: ts.Expression): Node[] => {
    while (ts.isParenthesizedExpression(e)) e = e.expression;
    if (ts.isIdentifier(e)) {
      const d = declOf(e);
      return d === undefined ? [] : [d];
    }
    if (!ts.isPropertyAccessExpression(e) && !ts.isElementAccessExpression(e)) return [];
    const op = readOps.get(e);
    if (op === undefined || op.name === null) return [];
    const objects = analysis.nodes[op.recv]!.atoms;
    const stores = analysis.ops
      .filter(
        (w) =>
          w.kind === "write" &&
          w.name === op.name &&
          [...analysis.nodes[w.recv]!.atoms].some((a) => objects.has(a)),
      )
      .map((w) => w.node);
    return [...stores, ...receiverDeps(e.expression)];
  };
  /** Whether `read` can only run after the statements holding `deps`: what
   * it reads exists by then, so a rewrite that no longer evaluates the read
   * cannot drop the TypeError or ReferenceError of an earlier read. In
   * another file, the defining module has finished loading unless it
   * requires the reading file. In the same file, a top-level read comes
   * after them. A read inside a function runs when the function is called:
   * the statements from the one that creates the function (the first, for
   * a hoisted declaration) to the last of them must only define things. */
  const createdBefore = (read: Node, deps: readonly Node[]): boolean => {
    const sf = read.getSourceFile();
    const stmts = sf.statements.nodes;
    let last = -1;
    for (const d of deps) {
      const file = d.getSourceFile();
      if (file !== sf) {
        if (requiredClosure(file).has(sf)) return false;
        continue;
      }
      const at = stmts.indexOf(topStatement(d)!);
      if (at < 0) return false;
      last = Math.max(last, at);
    }
    if (last < 0) return true;
    const top = topStatement(read)!;
    if (!insideFunction(read)) return stmts.indexOf(top) > last;
    let fn: Node | undefined;
    for (let p: Node | undefined = read.parent; p !== undefined && p !== top; p = p.parent)
      if (ts.isFunctionLike(p)) fn = p;
    const from = fn !== undefined && ts.isFunctionDeclaration(fn) ? 0 : stmts.indexOf(top);
    return stmts.slice(from, last + 1).every(definitionOnly);
  };
  const moduleBindings = new Map<string, string>();
  const exportAdds = new Map<ts.SourceFile, Set<string>>();
  const crossFileReference = (
    node: ts.PropertyAccessExpression,
    defining: ts.SourceFile,
    name: string,
  ): string | null => {
    if (process.env["SCRIPTC_SHAPE_CROSS_FILE_REFS"] === "0") return null;
    const sf = node.getSourceFile();
    if (!fileSet.has(sf) || exportLiteralOf(defining) === null) return null;
    // A cycle back to the reading file, directly or through other files,
    // could run the reading file's code before the module finished.
    if (requiredClosure(defining).has(sf)) return null;
    // A class is declared at its constructor's statement: an exports
    // literal before it would read the class before its declaration.
    const classStmt = classStatements.get(name);
    if (classStmt !== undefined) {
      const ds = defining.statements.nodes;
      const exportsAt = ds.indexOf(topStatement(exportLiteralOf(defining)!)!);
      if (exportsAt < ds.indexOf(classStmt)) return null;
    }
    // The reading file's top-level statement that loads the module.
    const stmts = sf.statements.nodes;
    const at = stmts.findIndex((st) => requiresWhenRun(sf, st, defining));
    if (at < 0) return null;
    const top = topStatement(node)!;
    const inFunction = insideFunction(node);
    if (!inFunction && stmts.indexOf(top) <= at) return null;
    // A function may run before the binding below is initialized if the
    // statement that loads the module, or one before it, runs other code
    // (`var m = require("lib"), x = f();`): then its reads stay as written.
    if (inFunction) {
      const values = statementValues(stmts[at]!);
      const onlyLoads = values !== null && values.every((v) => requireValue(v) !== null);
      if (!onlyLoads || !stmts.slice(0, at).every(definitionOnly)) return null;
    }
    const key = `${sf.fileName}\0${defining.fileName}`;
    let binding = moduleBindings.get(key);
    if (binding === undefined) {
      binding = `__ns_mod_${moduleBindings.size}`;
      for (let i = 1; used.has(binding); i++) binding = `__ns_mod_${moduleBindings.size}_${i}`;
      used.add(binding);
      moduleBindings.set(key, binding);
      const req = stmts[at]!;
      let spec: string | null = null;
      const find = (n: Node): void => {
        if (
          spec === null &&
          ts.isCallExpression(n) &&
          ts.isIdentifier(n.expression) &&
          n.expression.text === "require" &&
          requiredFiles(sf, n).includes(defining)
        )
          spec = n.arguments.nodes[0]!.getText();
        ts.forEachChild(n, find);
      };
      find(req);
      edit(sf, { start: req.end, end: req.end, text: `\nconst ${binding} = require(${spec!});` });
    }
    let adds = exportAdds.get(defining);
    if (adds === undefined) exportAdds.set(defining, (adds = new Set()));
    adds.add(name);
    return `${binding}.${name}`;
  };

  // Direct references: `e.k` (called, constructed or read) in the same file
  // whose receiver is exactly the constant object holding a hoisted
  // function or class.
  /** Whether `node` runs only after `store` has stored its function. */
  const runsAfter = (node: Node, store: { stmt: ts.Statement; fn: Node }): boolean => {
    for (let p: Node | undefined = node.parent; p !== undefined; p = p.parent) {
      // A function declaration is created, and may be called, before any
      // statement of its scope runs.
      if (ts.isFunctionDeclaration(p)) return false;
      if (p === store.fn) return true;
    }
    const top = topStatement(node);
    if (top === null) return false;
    const stmts = node.getSourceFile().statements.nodes;
    return stmts.indexOf(top) > stmts.indexOf(store.stmt);
  };
  for (const { op, atoms } of mergedOps) {
    if (op.kind !== "read" || op.name === null) continue;
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
    if (!ts.isPropertyAccessExpression(node)) continue;
    if (topStatement(node) === null) continue;
    // The receiver's evaluation is dropped, and the binding exists from the
    // store on (a function) or from its declaration on (a class).
    if (!pureReceiver(node.expression, node)) continue;
    if (!runsAfter(node, storeOf.get(field.values[0]!)!)) continue;
    // The reference replaces the whole member expression: its receiver
    // must be one that evaluating runs no code.
    if (!effectFree(node.expression)) {
      kept.push(`reference ${node.getText()}: the receiver may have effects`);
      continue;
    }
    if (!createdBefore(node, [field.values[0]!.node!, ...receiverDeps(node.expression)])) {
      kept.push(`reference ${node.getText()}: it may run before the member is stored`);
      continue;
    }
    if (node.getSourceFile() !== field.values[0]!.node!.getSourceFile()) {
      const text = crossFileReference(node, field.values[0]!.node!.getSourceFile(), name);
      if (text === null) continue;
      callEdits.push({
        sf: node.getSourceFile(),
        edit: { start: ts.tokenStartOfNode(node), end: node.end, text },
      });
      directCalls++;
      continue;
    }
    callEdits.push({
      sf: node.getSourceFile(),
      edit: { start: ts.tokenStartOfNode(node), end: node.end, text: name },
    });
    directCalls++;
  }

  // ── 4. constant primitive members ──────────────────────────────────
  // `e.k` whose receiver is exactly one constant object and whose member
  // is a primitive literal written in the object's own literal (`Kind = {
  // CIRCLE: 1 }`) reads that literal: the member exists from the moment
  // the object does and nothing writes it, so every read sees it. (A
  // member stored after the object was created could be read before the
  // store; those stay reads.)
  let foldedReads = 0;
  for (const { op, atoms } of mergedOps) {
    if (op.kind !== "read" || op.name === null) continue;
    if (atoms.size !== 1) continue;
    const o = constantAtoms.get([...atoms][0]!);
    if (o === undefined || o.site.kind !== "literal") continue;
    const field = o.fields.find((f) => f.key === op.name);
    if (field === undefined || field.stores !== 1) continue;
    const literal = ownLiteralMember(o.site.node, op.name);
    if (literal === null) continue;
    const node = op.node;
    if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) continue;
    if (!isPlainRead(node) || topStatement(node) === null) continue;
    if (!effectFree(node.expression)) {
      kept.push(`constant read ${node.getText()}: the receiver may have effects`);
      continue;
    }
    if (!createdBefore(node, [o.site.node, ...receiverDeps(node.expression)])) {
      kept.push(`constant read ${node.getText()}: it may run before the object is created`);
      continue;
    }
    callEdits.push({
      sf: node.getSourceFile(),
      edit: { start: ts.tokenStartOfNode(node), end: node.end, text: `(${literal})` },
    });
    foldedReads++;
  }

  // Text of a node with the direct calls inside it applied (an edit
  // inside another edit's range is part of that edit's text).
  const sliceWithCalls = (sf: ts.SourceFile, n: Node): string => {
    const from = ts.tokenStartOfNode(n);
    const inner = callEdits
      .filter((c) => c.sf === sf && c.edit.start >= from && c.edit.end <= n.end)
      .map((c) => c.edit)
      .sort((a, b) => a.start - b.start || b.end - a.end);
    let out = "";
    let at = from;
    for (const e of inner) {
      if (e.start < at) continue;
      out += sf.text.slice(at, e.start) + e.text;
      at = e.end;
    }
    return out + sf.text.slice(at, n.end);
  };

  // ── 3. calls through constant function tables ──────────────────────
  // `table[key](…)` where the table is exactly one constant object whose
  // members are all hoisted functions and the key is a string variable:
  // a comparison per member calls its function directly, and any other
  // key reads the table as written. The members do not use `this`, the
  // table has no accessors, and comparing a string runs no code, so only
  // the representation of the call changes.
  const tableCalls: { sf: ts.SourceFile; call: ts.CallExpression; arms: [string, string][] }[] = [];
  for (const { op, atoms } of mergedOps) {
    if (op.kind !== "computedRead") continue;
    const node = op.node;
    if (!ts.isElementAccessExpression(node) || node.questionDotToken !== undefined) continue;
    const call = node.parent;
    if (call === undefined || !ts.isCallExpression(call) || call.expression !== node) continue;
    if (call.questionDotToken !== undefined || topStatement(call) === null) continue;
    const where = `table call ${node.getText()}`;
    if (atoms.size !== 1) {
      kept.push(`${where}: the table may be ${atoms.size} values`);
      continue;
    }
    const o = constantAtoms.get([...atoms][0]!);
    if (o === undefined || o.fields.length === 0 || o.fields.length > MAX_TABLE_ARMS) {
      kept.push(`${where}: not a constant object of at most ${MAX_TABLE_ARMS} members`);
      continue;
    }
    // The arms call a member without evaluating the table expression.
    if (!effectFree(node.expression)) {
      kept.push(`${where}: the table expression may have effects`);
      continue;
    }
    const key = node.argumentExpression;
    if (!ts.isIdentifier(key)) continue;
    const keyDecl = declOf(key);
    if (keyDecl === undefined) continue;
    const keyValues = analysis.declValues(keyDecl);
    if (
      keyValues.size === 0 ||
      ![...keyValues].every((a) => a.kind === "prim" && a.label === "string")
    ) {
      kept.push(`${where}: the key may be ${[...keyValues].map((a) => a.label).join(" | ")}`);
      continue;
    }
    const arms: [string, string][] = [];
    for (const f of o.fields) {
      const fn = f.values.length === 1 ? f.values[0]! : undefined;
      const name = fn === undefined ? undefined : hoisted.get(fn);
      if (name === undefined || fn!.node!.getSourceFile() !== call.getSourceFile()) break;
      arms.push([f.key, name]);
    }
    if (arms.length !== o.fields.length) {
      kept.push(`${where}: a member is not a hoisted function of this file`);
      continue;
    }
    const armNodes = o.fields.map((f) => f.values[0]!.node!);
    if (!createdBefore(call, [o.site.node, ...armNodes, ...receiverDeps(node.expression)])) {
      kept.push(`${where}: it may run before the table is created`);
      continue;
    }
    tableCalls.push({ sf: call.getSourceFile(), call, arms });
  }
  for (const { sf, call, arms } of tableCalls) {
    const node = call.expression as ts.ElementAccessExpression;
    const key = node.argumentExpression.getText();
    const args = call.arguments.nodes.map((a) => sliceWithCalls(sf, a)).join(", ");
    const table = sliceWithCalls(sf, node.expression);
    const text = arms
      .map(([k, name]) => `${key} === ${JSON.stringify(k)} ? ${name}(${args}) : `)
      .join("");
    callEdits.push({
      sf,
      edit: {
        start: ts.tokenStartOfNode(call),
        end: call.end,
        text: `(${text}${table}[${key}](${args}))`,
      },
    });
    tableDispatches++;
  }
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
  for (const [sf, names] of exportAdds) {
    const literal = exportLiteralOf(sf)!;
    const props = literal.properties.nodes;
    const text = [...names].map((n) => `${n}: ${n}`).join(", ");
    const at = props.length > 0 ? props[props.length - 1]!.end : ts.tokenStartOfNode(literal) + 1;
    edit(sf, { start: at, end: at, text: props.length > 0 ? `, ${text}` : ` ${text} ` });
  }
  const out = new Map<string, string>();
  for (const [sf, edits] of editsByFile) out.set(sf.fileName, applyEdits(sf.text, edits));
  return { files: out, classes, functions, directCalls, tableDispatches, foldedReads, kept };
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

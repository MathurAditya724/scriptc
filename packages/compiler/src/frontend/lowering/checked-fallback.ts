/* Checked-cast fallback: a value that fails a checked cast keeps running.
 *
 * `JSON.parse(text) as T` (and `const x: T = anyValue`, `await res.json()
 * as T`) is a checked conversion: the static code after it reads `T`'s
 * native layout, so a value that does not fit `T` used to throw a
 * TypeError at the cast. Node never checks: the program continues with the
 * value it has. This module makes the failing case continue too, without
 * changing the code that runs when the value fits.
 *
 * The unit is a FALLBACK SITE: a function-local binding whose only write
 * is the checked cast (the ROOT), declared with `const`/`let` in a function
 * body. The code that can observe the root is the statements after the
 * cast in each enclosing statement list up to the root's declaration (the
 * TAILS; every other reference disqualifies the site). Each tail is lowered
 * twice:
 *
 * - the static lowering, exactly as before, used while the cast held;
 * - the dynamic lowering, used after a failure: the root reads its checked
 *   dynamic value (a shadow local), and every expression derived from it is
 *   typed `any` (fallbackTainted), so the region lowers through scriptc's
 *   ordinary `any` path, which has Node's semantics: missing members read
 *   undefined, values keep their real types, extra members stay visible,
 *   and objects keep their identity.
 *
 * `if (flag) dynamic else static` selects the lowering after each tail's
 * first statement; the cast sets the flag. A derived value that flows into
 * a typed slot outside the region (a typed parameter, a field, an outer
 * binding) passes the same checked conversion as any `any` value does
 * there: it continues when it fits and throws that conversion's TypeError
 * at that use when it does not. A statement of the dynamic lowering that
 * has no `any` lowering compiles to a runtime fence that throws at that
 * statement only when a failed value reaches it.
 *
 * Code without a fallback site is unchanged; code with one runs its static
 * tail unchanged behind one flag test per tail, and the cast reads one
 * thread-local word after the check (checkedCast.fallbackTaken).
 * `--tier=static-only` (and library mode) opens no sites: casts throw. */
import * as ts from "../ts7/adapter.js";
import {
  BOOL,
  DYN,
  type IrExpr,
  type IrLocal,
  type IrStmt,
  type IrType,
  type SrcLoc,
} from "../../ir/ir.js";
import { isJsSourceFile, locOf } from "../program.js";
import { PoisonError, type Lowerer } from "./lowerer.js";

export interface FallbackSite {
  root: ts.Symbol;
  /** The root's declared name (a module-level root is a module binding). */
  name: ts.Identifier;
  /** The statement holding the checked cast (the declaration itself, or
   * the `root = value as T` expression statement). */
  boundaryStmt: ts.Statement;
  /** Statements after which a tail starts, innermost first; removed as
   * their lists split. */
  anchors: Set<ts.Statement>;
  flag: IrLocal;
  shadow: IrLocal;
  armed: boolean;
  /** An initializer-less root's flag and shadow declarations, and the
   * statement list they were emitted into. */
  decls: { stmts: IrStmt[]; out: IrStmt[] } | null;
}

export interface FallbackTaint {
  symbols: Set<ts.Symbol>;
  memo: Map<ts.Node, boolean>;
}

/** Tails larger than this keep the throwing cast: every node is lowered
 * twice. */
const MAX_TAIL_NODES = 20000;

/** At most this many sites share a split point (2^n lowerings). */
const MAX_SHARED_SITES = 2;

type StatementList = { statements: { nodes: readonly ts.Statement[] } };

function isStatementList(node: ts.Node | undefined): boolean {
  return (
    node !== undefined && (ts.isBlock(node) || ts.isModuleBlock(node) || ts.isSourceFile(node))
  );
}

function listOf(node: ts.Node): readonly ts.Statement[] {
  return (node as unknown as StatementList).statements.nodes;
}

function strip(e: ts.Expression): ts.Expression {
  let v = e;
  while (ts.isParenthesizedExpression(v)) v = v.expression;
  return v;
}

function enclosingFunction(node: ts.Node): ts.Node | undefined {
  let n: ts.Node | undefined = node.parent;
  while (n !== undefined && !ts.isFunctionLike(n) && !ts.isSourceFile(n)) n = n.parent;
  return n;
}

/** `value as T` / `<T>value` over an `any` or `unknown` value, or a
 * dynamic value flowing into an annotated declaration. */
function isCheckedCast(lowerer: Lowerer, e: ts.Expression, declared: ts.Type | null): boolean {
  const dynamicFlags = ts.TypeFlags.Any | ts.TypeFlags.Unknown;
  const dynamic = (x: ts.Expression): boolean =>
    (lowerer.checker.getTypeAtLocation(x).flags & dynamicFlags) !== 0;
  const v = strip(e);
  if (ts.isAsExpression(v) || ts.isTypeAssertion(v)) {
    const target = lowerer.checker.getTypeFromTypeNode(v.type);
    if (target.flags & dynamicFlags) return false;
    return dynamic(strip(v.expression));
  }
  return declared !== null && (declared.flags & dynamicFlags) === 0 && dynamic(v);
}

function writesSymbol(lowerer: Lowerer, n: ts.Node, sym: ts.Symbol): ts.Node | null {
  const names = (e: ts.Node): boolean =>
    ts.isIdentifier(e) && lowerer.resolveValueSymbol(e) === sym;
  const targetNames = (t: ts.Expression): boolean => {
    const e = strip(t);
    if (names(e)) return true;
    if (ts.isArrayLiteralExpression(e) || ts.isObjectLiteralExpression(e)) {
      let found = false;
      const walk = (x: ts.Node): void => {
        if (names(x)) found = true;
        else ts.forEachChild(x, walk);
      };
      walk(e);
      return found;
    }
    return false;
  };
  if (ts.isBinaryExpression(n)) {
    const k = n.operatorToken.kind;
    if (
      k >= ts.SyntaxKind.FirstAssignment &&
      k <= ts.SyntaxKind.LastAssignment &&
      targetNames(n.left)
    )
      return n;
  } else if (
    (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) &&
    (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken) &&
    targetNames(n.operand as ts.Expression)
  ) {
    return n;
  } else if (
    (ts.isForOfStatement(n) || ts.isForInStatement(n)) &&
    !ts.isVariableDeclarationList(n.initializer) &&
    targetNames(n.initializer as ts.Expression)
  ) {
    return n;
  }
  return null;
}

/** Hoisted or registered-once declarations, and `super()` calls (which
 * initialize the instance once), that a second lowering would duplicate. */
function tailIsRelowerable(stmts: readonly ts.Statement[]): boolean {
  let ok = true;
  let count = 0;
  const visit = (n: ts.Node): void => {
    if (!ok) return;
    if (++count > MAX_TAIL_NODES) {
      ok = false;
      return;
    }
    if (
      ts.isFunctionDeclaration(n) ||
      ts.isClassDeclaration(n) ||
      ts.isClassExpression(n) ||
      ts.isModuleDeclaration(n) ||
      ts.isEnumDeclaration(n) ||
      (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.SuperKeyword) ||
      (ts.isVariableDeclarationList(n) &&
        (n.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const | ts.NodeFlags.Using)) === 0)
    ) {
      ok = false;
      return;
    }
    ts.forEachChild(n, visit);
  };
  for (const s of stmts) visit(s);
  return ok;
}

interface Candidate {
  root: ts.Symbol;
  name: ts.Identifier;
  boundaryStmt: ts.Statement;
  anchors: ts.Statement[];
}

/** The fallback site a declaration statement starts, or null. */
function fallbackCandidate(lowerer: Lowerer, stmt: ts.VariableStatement): Candidate | null {
  const list = stmt.declarationList;
  if ((list.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) === 0) return null;
  if ((list.flags & ts.NodeFlags.Using) !== 0) return null;
  if (list.declarations.nodes.length !== 1) return null;
  if (ts.canHaveModifiers(stmt) && (ts.getModifiers(stmt)?.length ?? 0) > 0) return null;
  const decl = list.declarations.nodes[0]!;
  if (!ts.isIdentifier(decl.name)) return null;
  if (isJsSourceFile(ts.getSourceFileOfNode(stmt))) return null;
  // Cheap gates before any scan: a checked-cast initializer, or a typed
  // declaration without one.
  const declared = decl.type !== undefined ? lowerer.checker.getTypeFromTypeNode(decl.type) : null;
  if (
    decl.initializer !== undefined
      ? !isCheckedCast(lowerer, decl.initializer, declared)
      : declared === null
  )
    return null;
  const rootList = stmt.parent;
  // Module-level bindings are module state (and module statements lower
  // one at a time): roots live in blocks.
  if (rootList === undefined || !ts.isBlock(rootList)) return null;
  const fn = enclosingFunction(stmt);
  if (fn === undefined) return null;
  const root = lowerer.checker.getSymbolAtLocation(decl.name);
  if (root === undefined) return null;
  // A root in a module-level block is scanned across its file.
  const body = ts.isSourceFile(fn) ? fn : (fn as ts.FunctionLikeDeclaration).body;
  if (body === undefined) return null;

  // The only write: the initializer, or one `root = value as T` statement.
  let boundaryStmt: ts.Statement | null = null;
  let boundaryWrite: ts.Node | null = null;
  const writes: ts.Node[] = [];
  const findWrites = (n: ts.Node): void => {
    const w = writesSymbol(lowerer, n, root);
    if (w) writes.push(w);
    ts.forEachChild(n, findWrites);
  };
  findWrites(body);
  if (decl.initializer !== undefined) {
    if (writes.length > 0) return null;
    boundaryStmt = stmt;
  } else {
    if (writes.length !== 1) return null;
    const w = writes[0]!;
    if (
      !ts.isBinaryExpression(w) ||
      w.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
      !ts.isIdentifier(strip(w.left)) ||
      !ts.isExpressionStatement(w.parent) ||
      !isCheckedCast(lowerer, w.right, declared)
    )
      return null;
    if (enclosingFunction(w) !== fn) return null;
    boundaryStmt = w.parent;
    boundaryWrite = w;
  }

  // The split points: the statement holding the cast in each enclosing
  // statement list, up to the root's list.
  const anchors: ts.Statement[] = [];
  let cur: ts.Node = boundaryStmt;
  for (;;) {
    const parent: ts.Node | undefined = cur.parent;
    if (parent === undefined || ts.isFunctionLike(parent)) return null;
    if (ts.isCaseClause(parent) || ts.isDefaultClause(parent)) return null;
    if (isStatementList(parent)) {
      anchors.push(cur as ts.Statement);
      if (parent === rootList) break;
      if (ts.isSourceFile(parent)) return null;
    }
    cur = parent;
  }
  const anchorIndex = new Map<ts.Node, { list: ts.Node; index: number }>();
  for (const a of anchors)
    anchorIndex.set(a, { list: a.parent!, index: listOf(a.parent!).indexOf(a) });
  const tails: ts.Statement[] = [];
  for (const a of anchors) {
    const { list, index } = anchorIndex.get(a)!;
    tails.push(...listOf(list).slice(index + 1));
  }
  if (!tailIsRelowerable(tails)) return null;

  // Every other reference sits in a tail.
  const inTail = (ref: ts.Node): boolean => {
    let n: ts.Node = ref;
    while (n.parent !== undefined && n !== body) {
      const parent = n.parent;
      if (isStatementList(parent)) {
        for (const a of anchors) {
          if (a.parent !== parent) continue;
          const at = anchorIndex.get(a)!.index;
          const mine = listOf(parent).indexOf(n as ts.Statement);
          if (mine > at) return true;
          if (mine < at) return false;
        }
      }
      n = parent;
    }
    return false;
  };
  let referencesOk = true;
  const scanRefs = (n: ts.Node): void => {
    if (!referencesOk) return;
    if (ts.isIdentifier(n) && n !== decl.name && lowerer.resolveValueSymbol(n) === root) {
      const isBoundaryTarget =
        boundaryWrite !== null &&
        ts.isBinaryExpression(boundaryWrite) &&
        strip(boundaryWrite.left) === n;
      if (!isBoundaryTarget && !inTail(n)) referencesOk = false;
      return;
    }
    ts.forEachChild(n, scanRefs);
  };
  scanRefs(body);
  if (!referencesOk) return null;
  return { root, name: decl.name, boundaryStmt, anchors };
}

function declareSiteLocals(
  lowerer: Lowerer,
  candidate: Candidate,
  loc: SrcLoc,
): { site: FallbackSite; decls: IrStmt[] } {
  const name = ts.symbolName(candidate.root);
  const flag = lowerer.declareHiddenLocal(`%fb.${name}`, BOOL);
  flag.mutable = true;
  const shadow = lowerer.declareHiddenLocal(`%fbv.${name}`, DYN);
  shadow.mutable = true;
  const decls: IrStmt[] = [
    {
      kind: "varDecl",
      localId: flag.id,
      init: { kind: "boolLit", value: false, type: BOOL, loc },
      loc,
    },
    { kind: "varDecl", localId: shadow.id, init: null, loc },
  ];
  const site: FallbackSite = {
    root: candidate.root,
    name: candidate.name,
    boundaryStmt: candidate.boundaryStmt,
    anchors: new Set(candidate.anchors),
    flag,
    shadow,
    armed: false,
    decls: null,
  };
  return { site, decls };
}

/** Before an initializer-less typed declaration lowers: open the fallback
 * site its later `root = value as T` statement starts, declaring the flag
 * (false) and the shadow that holds a failed value where the root is
 * declared. Declarations with an initializer open when they arm. */
export function openFallbackSite(lowerer: Lowerer, stmt: ts.Statement, out: IrStmt[]): void {
  if (!ts.isVariableStatement(stmt) || lowerer.fnStack.length === 0) return;
  if (lowerer.tierMode === "static-only") return;
  const decls = stmt.declarationList.declarations.nodes;
  if (decls.length !== 1 || decls[0]!.initializer !== undefined || decls[0]!.type === undefined)
    return;
  const candidate = fallbackCandidate(lowerer, stmt);
  if (candidate === null) return;
  const opened = declareSiteLocals(lowerer, candidate, locOf(stmt));
  out.push(...opened.decls);
  opened.site.decls = { stmts: opened.decls, out };
  lowerer.fallbackSites.set(candidate.root, opened.site);
}

/** A site that will not arm: drop its declarations again, so the program
 * lowers exactly as it did without the site. */
function closeUnarmed(lowerer: Lowerer, site: FallbackSite): void {
  const decls = site.decls;
  if (decls !== null) {
    for (const d of decls.stmts) {
      const at = decls.out.indexOf(d);
      if (at >= 0) decls.out.splice(at, 1);
    }
  }
  const locals = lowerer.ctx.locals;
  for (const local of [site.flag, site.shadow]) {
    const at = locals.indexOf(local);
    if (at >= 0) locals.splice(at, 1);
  }
}

const FALLBACK_TARGETS = new Set(["record", "array", "f64", "string", "bool"]);

/** A plain check of a record, array or scalar target that holds no class
 * instance: casts to program classes keep their checked semantics (a
 * documented scriptc boundary: a class cast checks the instance's class). */
function fallbackCheck(lowerer: Lowerer, check: IrExpr & { kind: "dynCheck" }): boolean {
  if (check.preserveRefs || check.exact || !FALLBACK_TARGETS.has(check.type.kind)) return false;
  return !holdsClassInstance(lowerer, check.type, new Set());
}

function holdsClassInstance(lowerer: Lowerer, t: IrType, seen: Set<string>): boolean {
  switch (t.kind) {
    case "object":
    case "classval":
      return true;
    case "array":
      return holdsClassInstance(lowerer, t.elem, seen);
    case "record": {
      if (seen.has(t.shapeId)) return false;
      seen.add(t.shapeId);
      const shape = lowerer.shapes.get(t.shapeId);
      if (shape === undefined) return true;
      if (shape.indexValue !== undefined && holdsClassInstance(lowerer, shape.indexValue, seen))
        return true;
      return shape.fields.some((f) => holdsClassInstance(lowerer, f.type, seen));
    }
    case "union": {
      const def = lowerer.unions.get(t.unionId);
      return def === undefined || def.arms.some((arm) => holdsClassInstance(lowerer, arm, seen));
    }
    default:
      return false;
  }
}

/** After a statement lowers: when it holds a fallback site's cast, mark the
 * check as a fallback check and read its outcome into the flag and the
 * shadow. A cast whose lowering is not a plain check keeps throwing. */
export function armFallbackSite(lowerer: Lowerer, stmt: ts.Statement, lowered: IrStmt[]): void {
  // `const root = value as T`: the check is the declaration's initializer.
  if (
    ts.isVariableStatement(stmt) &&
    lowerer.fnStack.length > 0 &&
    lowerer.tierMode !== "static-only" &&
    lowered.some((s) => s.kind === "varDecl" && s.init?.kind === "dynCheck")
  ) {
    const decls = stmt.declarationList.declarations.nodes;
    const decl = decls.length === 1 ? decls[0]! : undefined;
    if (decl?.initializer !== undefined && ts.isIdentifier(decl.name)) {
      const symbol = lowerer.checker.getSymbolAtLocation(decl.name);
      const local = symbol ? lowerer.bindingIn(lowerer.ctx, symbol) : null;
      const at =
        local === null
          ? -1
          : lowered.findIndex(
              (s) => s.kind === "varDecl" && s.localId === local.id && s.init?.kind === "dynCheck",
            );
      const write = at >= 0 ? lowered[at]! : null;
      const init = write?.kind === "varDecl" ? write.init : null;
      if (init?.kind === "dynCheck" && fallbackCheck(lowerer, init)) {
        const candidate = fallbackCandidate(lowerer, stmt);
        if (candidate !== null) {
          const opened = declareSiteLocals(lowerer, candidate, locOf(stmt));
          if (armSite(lowerer, opened.site, lowered, local!.id))
            lowered.splice(at, 0, ...opened.decls);
          else closeUnarmed(lowerer, opened.site);
        }
      }
    }
  }
  if (lowerer.fallbackSites.size === 0) return;
  for (const site of [...lowerer.fallbackSites.values()]) {
    if (site.boundaryStmt !== stmt || site.armed) continue;
    lowerer.fallbackSites.delete(site.root);
    const id = lowerer.bindingIn(lowerer.ctx, site.root)?.id;
    if (id === undefined || !armSite(lowerer, site, lowered, id)) closeUnarmed(lowerer, site);
  }
}

function armSite(lowerer: Lowerer, site: FallbackSite, lowered: IrStmt[], id: string): boolean {
  const at = lowered.findIndex(
    (s) =>
      (s.kind === "varDecl" && s.localId === id && s.init?.kind === "dynCheck") ||
      (s.kind === "assign" && s.localId === id && s.value.kind === "dynCheck"),
  );
  if (at < 0) return false;
  const write = lowered[at]!;
  let check: IrExpr | null = null;
  if (write.kind === "varDecl") check = write.init;
  else if (write.kind === "assign") check = write.value;
  if (check === null || check.kind !== "dynCheck" || !fallbackCheck(lowerer, check)) return false;
  // Every tail must split: each split point's list is lowering whole.
  const whole = [...site.anchors].every((anchor) => {
    const real = listOf(anchor.parent!);
    const index = real.indexOf(anchor);
    return lowerer.activeStmtLists.some(
      (entry) =>
        entry.stmts[entry.index] === anchor &&
        entry.stmts.length - entry.index === real.length - index,
    );
  });
  if (!whole) return false;
  // Sites sharing a split point multiply the lowerings.
  let shared = 0;
  for (const other of lowerer.fallbackArmed) {
    for (const a of other.anchors) if (site.anchors.has(a)) shared++;
  }
  if (shared >= MAX_SHARED_SITES) return false;
  check.fallback = true;
  const loc = check.loc;
  lowered.splice(
    at + 1,
    0,
    {
      kind: "assign",
      localId: site.flag.id,
      value: { kind: "libCall", fn: "checkedCast.fallbackTaken", args: [], type: BOOL, loc },
      loc,
    },
    {
      kind: "if",
      cond: { kind: "varRef", localId: site.flag.id, type: BOOL, loc },
      then: [
        {
          kind: "assign",
          localId: site.shadow.id,
          value: { kind: "libCall", fn: "checkedCast.fallbackTake", args: [], type: DYN, loc },
          loc,
        },
      ],
      else_: null,
      loc,
    },
  );
  site.armed = true;
  lowerer.fallbackArmed.push(site);
  return true;
}

/** Armed sites whose tail starts after `stmt`, consumed. */
export function fallbackSplitsAt(lowerer: Lowerer, stmt: ts.Statement): FallbackSite[] {
  if (lowerer.fallbackArmed.length === 0) return [];
  const here: FallbackSite[] = [];
  for (const site of lowerer.fallbackArmed) {
    if (site.anchors.delete(stmt)) here.push(site);
  }
  if (here.length > 0)
    lowerer.fallbackArmed = lowerer.fallbackArmed.filter((s) => s.anchors.size > 0);
  return here;
}

/** The tail after a split point: `if (flag) <dynamic> else <static>` per
 * site. The static lowering runs first and is exactly the lowering the
 * tail had without a site. */
export function lowerFallbackTail(
  lowerer: Lowerer,
  rest: readonly ts.Statement[],
  sites: readonly FallbackSite[],
): IrStmt[] {
  if (sites.length === 0) return lowerer.lowerStmts(rest);
  // An empty tail (the cast ends its block) needs no split.
  if (rest.length === 0) return [];
  const [site, ...others] = sites as [FallbackSite, ...FallbackSite[]];
  const at = locOf(rest.length > 0 ? rest[0]! : site.boundaryStmt);
  const statics = scoped(lowerer, () => lowerFallbackTail(lowerer, rest, others));
  const dynamic = lowerDynamicTail(lowerer, rest, site, others);
  return [
    {
      kind: "if",
      cond: { kind: "varRef", localId: site.flag.id, type: BOOL, loc: at },
      then: dynamic,
      else_: statics,
      loc: at,
    },
  ];
}

function scoped<T>(lowerer: Lowerer, lower: () => T, frame = new Map<ts.Symbol, IrLocal>()): T {
  lowerer.scopes.push(frame);
  try {
    return lower();
  } finally {
    lowerer.scopes.pop();
  }
}

function lowerDynamicTail(
  lowerer: Lowerer,
  rest: readonly ts.Statement[],
  site: FallbackSite,
  others: readonly FallbackSite[],
): IrStmt[] {
  const saved = {
    taint: lowerer.fallbackTaint,
    sink: lowerer.diagSink,
    stats: lowerer.suppressStats,
    sites: new Map(lowerer.fallbackSites),
    armed: lowerer.fallbackArmed,
    scopes: lowerer.scopes.length,
  };
  lowerer.fallbackTaint = fallbackTaintOf(lowerer, saved.taint, site.root, rest);
  lowerer.diagSink = [];
  lowerer.suppressStats = true;
  lowerer.fallbackArmed = [];
  try {
    return scoped(
      lowerer,
      () => lowerFallbackTail(lowerer, rest, others),
      new Map([[site.root, site.shadow]]),
    );
  } catch (error) {
    if (!(error instanceof PoisonError) && process.env.SCRIPTC_FALLBACK_DEBUG) throw error;
    while (lowerer.scopes.length > saved.scopes) lowerer.scopes.pop();
    const loc = rest.length > 0 ? locOf(rest[0]!) : locOf(site.boundaryStmt);
    return [
      {
        kind: "runtimeFence",
        code: "SC1090",
        message: `a value that failed its checked cast reached code with no dynamic lowering`,
        loc,
      },
    ];
  } finally {
    lowerer.fallbackTaint = saved.taint;
    lowerer.diagSink = saved.sink;
    lowerer.suppressStats = saved.stats;
    lowerer.fallbackSites = saved.sites;
    lowerer.fallbackArmed = saved.armed;
  }
}

/* ── taint: which expressions of a dynamic tail read a failed value ── */

/** True when `node`'s value derives from a failed checked value in the
 * dynamic lowering being built: it is typed `any` there. */
export function fallbackTainted(lowerer: Lowerer, node: ts.Node): boolean {
  const taint = lowerer.fallbackTaint;
  if (taint === null) return false;
  const known = taint.memo.get(node);
  if (known !== undefined) return known;
  taint.memo.set(node, false);
  const result = computeTainted(lowerer, taint, node);
  taint.memo.set(node, result);
  return result;
}

function computeTainted(lowerer: Lowerer, taint: FallbackTaint, node: ts.Node): boolean {
  const t = (n: ts.Node): boolean => fallbackTainted(lowerer, n);
  if (ts.isIdentifier(node)) {
    const sym = lowerer.resolveValueSymbol(node);
    return sym !== null && taint.symbols.has(sym);
  }
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertion(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isAwaitExpression(node)
  )
    return t(node.expression);
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
    return t(node.expression);
  if (ts.isCallExpression(node)) return t(node.expression);
  if (ts.isConditionalExpression(node)) return t(node.whenTrue) || t(node.whenFalse);
  if (ts.isBinaryExpression(node)) {
    const k = node.operatorToken.kind;
    switch (k) {
      case ts.SyntaxKind.QuestionQuestionToken:
      case ts.SyntaxKind.BarBarToken:
      case ts.SyntaxKind.AmpersandAmpersandToken:
      case ts.SyntaxKind.PlusToken:
        return t(node.left) || t(node.right);
      case ts.SyntaxKind.CommaToken:
      case ts.SyntaxKind.EqualsToken:
        return t(node.right);
      case ts.SyntaxKind.PlusEqualsToken:
      case ts.SyntaxKind.QuestionQuestionEqualsToken:
      case ts.SyntaxKind.BarBarEqualsToken:
      case ts.SyntaxKind.AmpersandAmpersandEqualsToken:
        return t(node.left) || t(node.right);
      default:
        return false;
    }
  }
  // A literal beside a failed value (`value ?? {}`, `ok ? value : []`)
  // is built dynamically too: its contextual type is the static one.
  if (ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node)) {
    // A literal spreading a failed value is built dynamically, and so is
    // one holding a failed value that initializes a binding (the binding
    // turns dynamic) or sits in such a literal. A literal flowing straight
    // into a typed slot keeps its layout: each failed member is checked
    // into its field, so members that fit continue.
    let holds = false;
    if (ts.isObjectLiteralExpression(node)) {
      for (const p of node.properties.nodes) {
        if (ts.isSpreadAssignment(p) && t(p.expression)) return true;
        if (
          (ts.isPropertyAssignment(p) && t(p.initializer)) ||
          (ts.isShorthandPropertyAssignment(p) && t(p.name))
        )
          holds = true;
      }
    } else {
      for (const e of node.elements.nodes)
        if (t(ts.isSpreadElement(e) ? e.expression : e)) holds = true;
    }
    if (holds) {
      // The outermost literal of a nest decides for all of it.
      let top: ts.Node = node;
      for (;;) {
        const host: ts.Node | undefined = top.parent;
        if (host !== undefined && ts.isPropertyAssignment(host) && host.parent !== undefined) {
          top = host.parent;
          continue;
        }
        if (host !== undefined && ts.isArrayLiteralExpression(host)) {
          top = host;
          continue;
        }
        break;
      }
      // An untyped destination (`console.log`, `JSON.stringify`) takes it
      // dynamically.
      const contextual = lowerer.checker.getContextualType(top);
      if (
        contextual !== undefined &&
        (contextual.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0
      )
        return true;
      const host = top.parent;
      if (host !== undefined && ts.isVariableDeclaration(host) && host.initializer === top)
        return true;
    }
    let child: ts.Node = node;
    let parent = node.parent;
    while (parent !== undefined && ts.isParenthesizedExpression(parent)) {
      child = parent;
      parent = parent.parent;
    }
    if (parent === undefined) return false;
    if (ts.isBinaryExpression(parent)) {
      const k = parent.operatorToken.kind;
      if (
        k === ts.SyntaxKind.QuestionQuestionToken ||
        k === ts.SyntaxKind.BarBarToken ||
        k === ts.SyntaxKind.AmpersandAmpersandToken
      )
        return t(parent.left === child ? parent.right : parent.left);
    }
    if (ts.isConditionalExpression(parent) && parent.condition !== child)
      return t(parent.whenTrue === child ? parent.whenFalse : parent.whenTrue);
    return false;
  }
  if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
    if (
      node.operator === ts.SyntaxKind.PlusPlusToken ||
      node.operator === ts.SyntaxKind.MinusMinusToken
    )
      return t(node.operand);
    return false;
  }
  return false;
}

/** The taint of a dynamic tail: the root, and every binding declared in the
 * tail that a tainted value is written to (a fixpoint over the tail,
 * nested functions included). Parameters of callbacks passed to a tainted
 * callee are tainted too: the dynamic call passes them dynamic values. */
function fallbackTaintOf(
  lowerer: Lowerer,
  outer: FallbackTaint | null,
  root: ts.Symbol,
  region: readonly ts.Statement[],
): FallbackTaint {
  const symbols = new Set(outer?.symbols ?? []);
  symbols.add(root);
  const taint: FallbackTaint = { symbols, memo: new Map() };
  const saved = lowerer.fallbackTaint;
  lowerer.fallbackTaint = taint;
  try {
    growTaint(lowerer, taint, region);
  } finally {
    lowerer.fallbackTaint = saved;
  }
  return taint;
}

function growTaint(lowerer: Lowerer, taint: FallbackTaint, region: readonly ts.Statement[]): void {
  const symbols = taint.symbols;
  const declared = new Set<ts.Symbol>();
  const collectDeclared = (n: ts.Node): void => {
    if (
      (ts.isVariableDeclaration(n) || ts.isParameter(n) || ts.isBindingElement(n)) &&
      ts.isIdentifier(n.name)
    ) {
      const s = lowerer.checker.getSymbolAtLocation(n.name);
      if (s) declared.add(s);
    }
    ts.forEachChild(n, collectDeclared);
  };
  for (const s of region) collectDeclared(s);
  const bindNames = (name: ts.BindingName): boolean => {
    let changed = false;
    const visit = (n: ts.Node): void => {
      if (ts.isIdentifier(n)) {
        const s = lowerer.checker.getSymbolAtLocation(n);
        if (s && !symbols.has(s)) {
          symbols.add(s);
          changed = true;
        }
        return;
      }
      if (ts.isBindingElement(n)) {
        if (n.name !== undefined) visit(n.name);
        return;
      }
      ts.forEachChild(n, visit);
    };
    visit(name);
    return changed;
  };
  for (let round = 0; round < 32; round++) {
    let changed = false;
    taint.memo.clear();
    const visit = (n: ts.Node): void => {
      if (
        ts.isVariableDeclaration(n) &&
        n.initializer !== undefined &&
        fallbackTainted(lowerer, n.initializer)
      ) {
        if (bindNames(n.name)) changed = true;
      } else if (ts.isBinaryExpression(n)) {
        const k = n.operatorToken.kind;
        if (
          k >= ts.SyntaxKind.FirstAssignment &&
          k <= ts.SyntaxKind.LastAssignment &&
          ts.isIdentifier(strip(n.left))
        ) {
          const s = lowerer.resolveValueSymbol(strip(n.left) as ts.Identifier);
          if (s && declared.has(s) && !symbols.has(s) && fallbackTainted(lowerer, n.right)) {
            symbols.add(s);
            changed = true;
          }
        }
      } else if (
        ts.isForOfStatement(n) &&
        ts.isVariableDeclarationList(n.initializer) &&
        fallbackTainted(lowerer, n.expression)
      ) {
        for (const d of n.initializer.declarations.nodes) if (bindNames(d.name)) changed = true;
      } else if (ts.isCallExpression(n) && fallbackTainted(lowerer, n.expression)) {
        for (const arg of n.arguments.nodes) {
          const a = strip(arg);
          if (ts.isArrowFunction(a) || ts.isFunctionExpression(a)) {
            for (const p of a.parameters.nodes) if (bindNames(p.name)) changed = true;
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    for (const s of region) visit(s);
    if (!changed) break;
  }
  taint.memo.clear();
}

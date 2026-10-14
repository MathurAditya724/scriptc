import {
  typeEquals,
  type IrExpr,
  type IrFunction,
  type IrLocal,
  type IrModule,
  type IrStmt,
} from "./ir.js";
import { AmbientReceiverReaders } from "./receiver-readers.js";
import { reparseStmt } from "./serialize.js";
import {
  everyExprChild,
  everyStmtChild,
  everyStmtList,
  mapExprChildren,
  mapStmtChildren,
} from "./traverse.js";

/** Captured bindings that hold one value for their whole observable life
 * read through plain immutable locals.
 *
 * A captured binding lives in a shared box: the declaring function and
 * every closure environment that captures it address the same cell, so a
 * write anywhere is visible everywhere. When nothing ever writes the cell
 * after its declaration fills it, the box is only a carrier: every read
 * observes the declaration's value. Analyses and code generation exclude
 * boxed locals, though, so a boxed `const N` turns all integer index math
 * that reads it into checked f64 arithmetic and every reference read into
 * an out-of-line retained box load.
 *
 * This pass keeps the boxes (environments still capture and trace them
 * exactly as before, so ownership and cycle collection are unchanged) and
 * moves the reads onto plain locals:
 *
 * - In the declaring function, `varDecl x = init` becomes
 *   `varDecl x' = init; varDecl x = x'`, and every read of `x` reads `x'`.
 *   An unchanged captured number parameter `p` gets `varDecl p' = p` at
 *   entry in the same way.
 * - In a closure body, an entry `varDecl c' = c` copies the environment's
 *   value once and every read of `c` reads `c'`. When every creation site
 *   captures a declaration of the same closed numeric constant, `c'`
 *   starts from that literal instead, so range analysis sees the constant.
 *
 * Nested environments still capture the original box. A call through such
 * a binding whose only value is an environment-free function (a nested
 * function declaration or arrow that captures nothing) becomes a direct
 * call of a capture-free copy of that body, as a call of a top-level
 * function is: the closure value itself still exists for every other use.
 *
 * Soundness. A binding qualifies when its box is filled exactly once
 * before any environment can observe it and nothing rebinds it in any
 * function that shares the box:
 *
 * - temporal-dead-zone bindings never qualify (an environment created
 *   before the declaration can observe the empty box),
 * - the declaration is the binding's only `varDecl` and has an
 *   initializer that does not itself create an environment over it,
 * - no `assign`, `assignExpr`, `incDec`, `forOf`, catch or rethrow binding
 *   targets it, here or in any closure body reached through capture edges,
 * - local classes keep their boxes (method bodies are not followed).
 *
 * A closure capture qualifies when every creation site supplies such a
 * binding, an unchanged parameter, or a qualifying capture of the creating
 * closure. A closure can only run after its creation, so its entry copy
 * reads the final value. Every execution of a declaration (for example
 * per loop iteration) fills its own fresh box, so environments created in
 * different iterations keep seeing their own value. */
export function copyStableCaptures(mod: IrModule): IrModule {
  const flow = new CaptureFlow(mod.functions);
  let changed = false;
  const functions = mod.functions.map((fn) => {
    const next = flow.rewrite(fn);
    if (next !== fn) changed = true;
    return next;
  });
  if (!changed) return mod;
  const rewritten = new Map(functions.map((fn) => [fn.name, fn]));
  for (const [name, clone] of flow.directClones()) {
    const { captures: _captures, ...plain } = rewritten.get(name)!;
    // Analyses key facts by node identity: the copy gets its own nodes.
    functions.push({ ...plain, name: clone, body: plain.body.map(reparseStmt) });
  }
  return { ...mod, functions };
}

/** The value of a closed numeric expression over literals (`1024`,
 * `-1`, `4 * 256`), evaluated with the same IEEE double arithmetic. */
function constantNumber(e: IrExpr): number | null {
  if (e.type.kind !== "f64") return null;
  if (e.kind === "numLit") return e.value;
  if (e.kind === "unary" && e.op === "-") {
    const operand = constantNumber(e.operand);
    return operand === null ? null : -operand;
  }
  if (e.kind !== "bin") return null;
  const left = constantNumber(e.left);
  const right = left === null ? null : constantNumber(e.right);
  if (left === null || right === null) return null;
  switch (e.op) {
    case "+":
      return left + right;
    case "-":
      return left - right;
    case "*":
      return left * right;
    case "/":
      return left / right;
    default:
      return null;
  }
}

/** Literals worth propagating: special values keep their declaration. */
function plainLiteral(value: number | null): number | null {
  return value !== null && Number.isFinite(value) && !Object.is(value, -0) ? value : null;
}

interface Declaration {
  count: number;
  /** Every occurrence has an initializer that creates no environment over
   * the binding itself. */
  initialized: boolean;
  /** Every occurrence sits directly in a statement list whose scope is the
   * binding's own block: not a `for` head, a switch case or an expression. */
  splittable: boolean;
  /** The single initializer's value, when that is a closed numeric
   * constant. */
  literal: number | null;
  /** The single initializer. */
  init: IrExpr | null;
}

interface FunctionFacts {
  locals: Map<string, IrLocal>;
  declarations: Map<string, Declaration>;
  /** Rebinding writes per binding: statement and expression assignments,
   * increments, loop, catch and rethrow bindings. */
  writes: Map<string, number>;
  /** Hoisted function bindings: `varDecl f null`, then only further
   * function-binding statements, then this `assign f = closure`. Nothing
   * can run in between, so no environment can observe the empty box. */
  hoisted: Map<string, IrStmt>;
  /** Bindings called through `callValue` without a receiver. */
  callees: Set<string>;
  classCaptured: Set<string>;
  reads: Map<string, number>;
  /** Closure capture edges: the creator's binding `source` flows into
   * capture `local` of `target`. */
  edges: { target: string; index: number; source: string }[];
}

interface CreationSite {
  owner: string;
  captures: string[];
  adapts: boolean;
}

/** Capture-flow facts over the whole module. Capture chains follow lexical
 * nesting and cannot cycle; provisional memo entries only bound work on
 * malformed input. */
export class CaptureFlow {
  private readonly functions = new Map<string, IrFunction>();
  private readonly facts = new Map<string, FunctionFacts>();
  private readonly unchangedMemo = new Map<string, boolean>();
  private readonly stableMemo = new Map<string, boolean>();
  private readonly sites = new Map<string, CreationSite[]>();
  private readonly receivers: AmbientReceiverReaders;
  private readonly directMemo = new Map<string, boolean>();
  /** Environment-free bodies called directly, and their copies' names. */
  private readonly clones = new Map<string, string>();

  constructor(functions: readonly IrFunction[]) {
    for (const fn of functions) this.functions.set(fn.name, fn);
    this.receivers = new AmbientReceiverReaders(this.functions);
    // Creation sites are collected while scanning each body.
    for (const fn of functions) this.factsOf(fn);
  }

  directClones(): ReadonlyMap<string, string> {
    return this.clones;
  }

  /** A lifted body that captures nothing and can be entered like a declared
   * function: synchronous, never naming its own closure, and unable to
   * observe the ambient receiver a closure call would bracket. */
  private direct(fnName: string): boolean {
    const known = this.directMemo.get(fnName);
    if (known !== undefined) return known;
    const fn = this.functions.get(fnName);
    const result =
      fn !== undefined &&
      fn.captures?.length === 0 &&
      fn.classCaptures === undefined &&
      fn.async !== true &&
      fn.generator === undefined &&
      everyStmtList(fn.body, { stmt: () => true, expr: (e) => e.kind !== "selfRef" }) &&
      this.receivers.ignores(fn);
    this.directMemo.set(fnName, result);
    return result;
  }

  /** The environment-free function every execution binds to `id`, if any. */
  private target(fnName: string, id: string, depth = 0): string | null {
    const fn = this.functions.get(fnName);
    if (fn === undefined || depth > 64) return null;
    const facts = this.factsOf(fn);
    const own = facts.declarations.get(id);
    if (own !== undefined) {
      const local = facts.locals.get(id);
      if (local?.boxed === true ? !this.stableOrigin(fn, id) : !this.plainConstant(fn, id))
        return null;
      const hoisted = facts.hoisted.get(id);
      const value = own.initialized ? own.init : hoisted?.kind === "assign" ? hoisted.value : null;
      return value?.kind === "closure" &&
        value.captures.length === 0 &&
        value.adapts !== true &&
        this.direct(value.fnName)
        ? value.fnName
        : null;
    }
    const index = fn.captures?.findIndex((c) => c.localId === id) ?? -1;
    if (index < 0 || !this.stableCapture(fnName, id)) return null;
    let result: string | null = null;
    for (const site of this.sites.get(fnName) ?? []) {
      const source = site.captures[index];
      const next = source === undefined ? null : this.target(site.owner, source, depth + 1);
      if (next === null || (result !== null && result !== next)) return null;
      result = next;
    }
    return result;
  }

  /** An unboxed binding (no environment shares it) of `fn` itself that
   * holds its single definition from its first read on. */
  private plainConstant(fn: IrFunction, id: string): boolean {
    const facts = this.factsOf(fn);
    const local = facts.locals.get(id);
    const declaration = facts.declarations.get(id);
    if (local === undefined || local.boxed === true || local.tdz === true) return false;
    if (fn.params.some((p) => p.localId === id) || declaration?.count !== 1) return false;
    const writes = facts.writes.get(id) ?? 0;
    return declaration.initialized ? writes === 0 : facts.hoisted.has(id) && writes === 1;
  }

  /** `callValue` through a binding bound to one environment-free function,
   * as a direct call of its capture-free copy. */
  private directCall(fnName: string, e: IrExpr & { kind: "callValue" }): string | null {
    if (e.receiver !== undefined || e.callee.kind !== "varRef") return null;
    const target = this.target(fnName, e.callee.localId);
    const callee = target === null ? undefined : this.functions.get(target);
    const ft = e.callee.type;
    if (callee === undefined || ft.kind !== "func") return null;
    if (
      callee.params.length !== e.args.length ||
      ft.params.length !== e.args.length ||
      !typeEquals(callee.returnType, e.type) ||
      !callee.params.every((p, i) => typeEquals(p.type, ft.params[i]!))
    )
      return null;
    let clone = this.clones.get(callee.name);
    if (clone === undefined) {
      clone = `${callee.name}%direct`;
      this.clones.set(callee.name, clone);
    }
    return clone;
  }

  private factsOf(fn: IrFunction): FunctionFacts {
    const known = this.facts.get(fn.name);
    if (known !== undefined) return known;
    const facts: FunctionFacts = {
      locals: new Map(fn.locals.map((local) => [local.id, local])),
      declarations: new Map(),
      writes: new Map(),
      hoisted: new Map(),
      callees: new Set(),
      classCaptured: new Set(),
      reads: new Map(),
      edges: [],
    };
    this.facts.set(fn.name, facts);
    const capturesIn = (e: IrExpr): Set<string> => {
      const ids = new Set<string>();
      const visitExpr = (node: IrExpr): boolean => {
        if (node.kind === "closure" || node.kind === "classRef")
          for (const id of node.captures ?? []) ids.add(id);
        return everyExprChild(node, visitExpr, visitStmt);
      };
      const visitStmt = (node: IrStmt): boolean => everyStmtChild(node, visitExpr, visitStmt);
      visitExpr(e);
      return ids;
    };
    const findHoisted = (body: readonly IrStmt[]): void => {
      body.forEach((s, i) => {
        if (s.kind !== "varDecl" || s.init !== null) return;
        for (let j = i + 1; j < body.length; j++) {
          const next = body[j]!;
          if (next.kind === "assign" && next.value.kind === "closure") {
            if (next.localId === s.localId) {
              facts.hoisted.set(s.localId, next);
              return;
            }
          } else if (next.kind !== "varDecl" || next.init !== null) return;
        }
      });
    };
    const declare = (s: IrStmt & { kind: "varDecl" }, splittable: boolean): void => {
      const entry = facts.declarations.get(s.localId);
      const initialized = s.init !== null && !capturesIn(s.init).has(s.localId);
      const literal = s.init === null ? null : plainLiteral(constantNumber(s.init));
      if (entry === undefined)
        facts.declarations.set(s.localId, {
          count: 1,
          initialized,
          splittable,
          literal,
          init: s.init,
        });
      else {
        entry.count++;
        entry.initialized = false;
        entry.splittable = false;
        entry.literal = null;
        entry.init = null;
      }
    };
    const write = (id: string): void => {
      facts.writes.set(id, (facts.writes.get(id) ?? 0) + 1);
    };
    const expr = (e: IrExpr): boolean => {
      switch (e.kind) {
        case "varRef":
          facts.reads.set(e.localId, (facts.reads.get(e.localId) ?? 0) + 1);
          break;
        case "assignExpr":
        case "incDec":
          write(e.localId);
          break;
        case "closure": {
          let list = this.sites.get(e.fnName);
          if (list === undefined) this.sites.set(e.fnName, (list = []));
          list.push({ owner: fn.name, captures: e.captures, adapts: e.adapts === true });
          e.captures.forEach((source, index) =>
            facts.edges.push({ target: e.fnName, index, source }),
          );
          break;
        }
        case "classRef":
          for (const id of e.captures ?? []) facts.classCaptured.add(id);
          break;
        case "callValue":
          if (e.receiver === undefined && e.callee.kind === "varRef")
            facts.callees.add(e.callee.localId);
          break;
      }
      return everyExprChild(e, expr, (s) => stmt(s, false));
    };
    // `split` mirrors rewrite(): only statement lists reached through
    // ordinary nesting from the body are expanded. Switch cases share one
    // scope across dispatch targets, `for` heads are freshened per
    // iteration, and statement lists inside expressions release their
    // locals with the enclosing frame; declarations there stay as they are.
    const list = (body: readonly IrStmt[], split: boolean): boolean => {
      if (split) findHoisted(body);
      return body.every((s) => stmt(s, split));
    };
    const stmt = (s: IrStmt, split: boolean): boolean => {
      switch (s.kind) {
        case "varDecl":
          declare(s, split);
          return s.init === null || expr(s.init);
        case "assign":
        case "rethrow":
          write(s.localId);
          break;
        case "forOf":
          write(s.localId);
          return expr(s.iterable) && list(s.body, split);
        case "tryCatch":
          if (s.catchLocalId !== null) write(s.catchLocalId);
          return (
            list(s.tryBody, split) &&
            (s.catchBody === null || list(s.catchBody, split)) &&
            (s.finallyBody === null || list(s.finallyBody, split))
          );
        case "block":
          return list(s.body, split);
        case "if":
          return expr(s.cond) && list(s.then, split) && (s.else_ === null || list(s.else_, split));
        case "while":
          return expr(s.cond) && list(s.body, split);
        case "doWhile":
          return list(s.body, split) && expr(s.cond);
        case "for":
          return (
            (s.init === null || stmt(s.init, false)) &&
            (s.cond === null || expr(s.cond)) &&
            (s.update === null || stmt(s.update, false)) &&
            list(s.body, split)
          );
      }
      return everyStmtChild(s, expr, (child) => stmt(child, false));
    };
    list(fn.body, true);
    return facts;
  }

  private local(fn: IrFunction, id: string): IrLocal | undefined {
    return this.factsOf(fn).locals.get(id);
  }

  /** Nothing rebinds `id` in `fnName` (declarations aside, and `ownWrites`
   * writes of its own body) or in any body that shares its box through
   * closure captures. */
  unchanged(fnName: string, id: string, ownWrites = 0): boolean {
    const key = `${fnName}\0${id}\0${ownWrites}`;
    const known = this.unchangedMemo.get(key);
    if (known !== undefined) return known;
    this.unchangedMemo.set(key, false);
    const fn = this.functions.get(fnName);
    let result = false;
    if (fn !== undefined) {
      const facts = this.factsOf(fn);
      result =
        (facts.writes.get(id) ?? 0) === ownWrites &&
        !facts.classCaptured.has(id) &&
        facts.edges.every((edge) => {
          if (edge.source !== id) return true;
          const capture = this.functions.get(edge.target)?.captures?.[edge.index];
          return capture !== undefined && this.unchanged(edge.target, capture.localId);
        });
    }
    this.unchangedMemo.set(key, result);
    return result;
  }

  /** A boxed binding of `fn` itself (not a capture) whose box is filled
   * once, before any environment observes it, and never written again. */
  stableOrigin(fn: IrFunction, id: string): boolean {
    const local = this.local(fn, id);
    if (local?.boxed !== true || local.tdz === true) return false;
    if (fn.captures?.some((c) => c.localId === id)) return false;
    if (fn.classCaptures?.some((c) => c.localId === id)) return false;
    const facts = this.factsOf(fn);
    const declaration = facts.declarations.get(id);
    if (fn.params.some((p) => p.localId === id))
      return declaration === undefined && this.unchanged(fn.name, id);
    if (declaration?.count !== 1) return false;
    if (declaration.initialized) return this.unchanged(fn.name, id);
    return facts.hoisted.has(id) && this.unchanged(fn.name, id, 1);
  }

  /** A closure capture holding one value for the environment's life. */
  stableCapture(fnName: string, id: string): boolean {
    const key = `${fnName}\0${id}`;
    const known = this.stableMemo.get(key);
    if (known !== undefined) return known;
    this.stableMemo.set(key, false);
    const result = this.computeStableCapture(fnName, id);
    this.stableMemo.set(key, result);
    return result;
  }

  private computeStableCapture(fnName: string, id: string): boolean {
    const fn = this.functions.get(fnName);
    const index = fn?.captures?.findIndex((c) => c.localId === id) ?? -1;
    if (fn === undefined || index < 0) return false;
    if (this.local(fn, id)?.tdz === true) return false;
    const sites = this.sites.get(fnName);
    if (sites === undefined || sites.length === 0) return false;
    for (const site of sites) {
      const owner = this.functions.get(site.owner);
      const source = site.captures[index];
      if (owner === undefined || source === undefined || site.adapts) return false;
      if (!this.stableOrigin(owner, source) && !this.stableCapture(site.owner, source))
        return false;
    }
    return this.unchanged(fnName, id);
  }

  /** The numeric constant every execution binds to `id`, if any. */
  private literal(fnName: string, id: string, depth = 0): number | null {
    const fn = this.functions.get(fnName);
    if (fn === undefined || depth > 64) return null;
    const own = this.factsOf(fn).declarations.get(id);
    if (own !== undefined) return this.stableOrigin(fn, id) ? own.literal : null;
    const index = fn.captures?.findIndex((c) => c.localId === id) ?? -1;
    if (index < 0 || !this.stableCapture(fnName, id)) return null;
    let value: number | null = null;
    for (const site of this.sites.get(fnName) ?? []) {
      const source = site.captures[index];
      const next = source === undefined ? null : this.literal(site.owner, source, depth + 1);
      if (next === null || (value !== null && !Object.is(value, next))) return null;
      value = next;
    }
    return value;
  }

  rewrite(fn: IrFunction): IrFunction {
    const facts = this.factsOf(fn);
    const reads = new Map<string, string>();
    const splits = new Map<string, string>();
    const entry: IrStmt[] = [];
    const locals: IrLocal[] = [];
    const used = new Set(fn.locals.map((l) => l.id));
    const fresh = (local: IrLocal): IrLocal => {
      let k = 0;
      while (used.has(`${local.name}.${k}`)) k++;
      const id = `${local.name}.${k}`;
      used.add(id);
      const copy: IrLocal = { id, name: local.name, type: local.type, mutable: false };
      if (local.source !== undefined) copy.source = local.source;
      locals.push(copy);
      return copy;
    };
    const adapted = (this.sites.get(fn.name) ?? []).some((site) => site.adapts);
    // Bindings nothing writes after their only initialization. Marking
    // them immutable lets later analyses (callback resolution, borrowing)
    // treat them as the constants they are.
    const immutable = new Set<string>();
    for (const local of fn.locals) {
      if (local.boxed !== true || local.tdz === true) continue;
      const capture = fn.captures?.some((c) => c.localId === local.id) === true;
      const param = fn.params.some((p) => p.localId === local.id);
      if (capture && local.mutable && this.stableCapture(fn.name, local.id))
        immutable.add(local.id);
      if (!facts.reads.has(local.id)) continue;
      if (capture) {
        if (adapted || !this.stableCapture(fn.name, local.id)) continue;
        const copy = fresh(local);
        const literal = local.type.kind === "f64" ? this.literal(fn.name, local.id) : null;
        const init: IrExpr =
          literal !== null
            ? { kind: "numLit", value: literal, type: local.type, loc: fn.loc }
            : { kind: "varRef", localId: local.id, type: local.type, loc: fn.loc };
        entry.push({ kind: "varDecl", localId: copy.id, init, loc: fn.loc });
        reads.set(local.id, copy.id);
      } else if (param) {
        // Unchanged captured parameters already keep their value in a plain
        // slot (the backend boxes them lazily); a copy only exposes numbers
        // to range analysis.
        if (local.type.kind !== "f64" || !this.stableOrigin(fn, local.id)) continue;
        const copy = fresh(local);
        entry.push({
          kind: "varDecl",
          localId: copy.id,
          init: { kind: "varRef", localId: local.id, type: local.type, loc: fn.loc },
          loc: fn.loc,
        });
        reads.set(local.id, copy.id);
      } else {
        if (!this.stableOrigin(fn, local.id)) continue;
        const declaration = facts.declarations.get(local.id)!;
        // A hoisted function binding splits at its assignment, which
        // findHoisted only records in expandable statement lists.
        if (declaration.initialized ? !declaration.splittable : !facts.hoisted.has(local.id))
          continue;
        const copy = fresh(local);
        splits.set(local.id, copy.id);
        reads.set(local.id, copy.id);
        if (declaration.initialized && local.mutable) immutable.add(local.id);
      }
    }
    const calls = [...facts.callees].some((id) => this.target(fn.name, id) !== null);
    if (reads.size === 0 && immutable.size === 0 && !calls) return fn;
    const localsById = new Map(fn.locals.map((l) => [l.id, l]));
    const expr = (e: IrExpr): IrExpr => {
      if (e.kind === "varRef") {
        const to = reads.get(e.localId);
        return to === undefined ? e : { ...e, localId: to };
      }
      if (e.kind === "callValue" && e.callee.kind === "varRef") {
        const callee = this.directCall(fn.name, e);
        if (callee !== null)
          return { kind: "call", callee, args: e.args.map(expr), type: e.type, loc: e.loc };
      }
      return mapExprChildren(e, expr, single);
    };
    const single = (s: IrStmt): IrStmt => mapStmtChildren(s, expr, single);
    const list = (body: readonly IrStmt[]): IrStmt[] => body.flatMap(many);
    const many = (s: IrStmt): IrStmt[] => {
      switch (s.kind) {
        case "varDecl": {
          const to = splits.get(s.localId);
          if (to === undefined || s.init === null) break;
          const local = localsById.get(s.localId)!;
          return [
            { ...s, localId: to, init: expr(s.init) },
            {
              kind: "varDecl",
              localId: s.localId,
              init: { kind: "varRef", localId: to, type: local.type, loc: s.loc },
              loc: s.loc,
            },
          ];
        }
        case "assign": {
          const to = splits.get(s.localId);
          if (to === undefined || facts.hoisted.get(s.localId) !== s) break;
          const local = localsById.get(s.localId)!;
          return [
            { kind: "varDecl", localId: to, init: expr(s.value), loc: s.loc },
            { ...s, value: { kind: "varRef", localId: to, type: local.type, loc: s.loc } },
          ];
        }
        case "block":
          return [{ ...s, body: list(s.body) }];
        case "if":
          return [
            {
              ...s,
              cond: expr(s.cond),
              then: list(s.then),
              else_: s.else_ === null ? null : list(s.else_),
            },
          ];
        case "while":
          return [{ ...s, cond: expr(s.cond), body: list(s.body) }];
        case "doWhile":
          return [{ ...s, body: list(s.body), cond: expr(s.cond) }];
        case "for":
          return [
            {
              ...s,
              init: s.init === null ? null : single(s.init),
              cond: s.cond === null ? null : expr(s.cond),
              update: s.update === null ? null : single(s.update),
              body: list(s.body),
            },
          ];
        case "forOf":
          return [{ ...s, iterable: expr(s.iterable), body: list(s.body) }];
        case "tryCatch":
          return [
            {
              ...s,
              tryBody: list(s.tryBody),
              catchBody: s.catchBody === null ? null : list(s.catchBody),
              finallyBody: s.finallyBody === null ? null : list(s.finallyBody),
            },
          ];
      }
      return [single(s)];
    };
    const kept = fn.locals.map((local) =>
      immutable.has(local.id) ? immutableLocal(local) : local,
    );
    if (reads.size === 0 && !calls) return { ...fn, locals: kept };
    const body = list(fn.body);
    // Direct calls can leave an entry copy unread.
    const readIds = new Set<string>();
    everyStmtList(body, {
      stmt: () => true,
      expr: (e) => {
        if (e.kind === "varRef") readIds.add(e.localId);
        return true;
      },
    });
    const live = entry.filter((s) => s.kind !== "varDecl" || readIds.has(s.localId));
    const liveIds = new Set(live.map((s) => (s.kind === "varDecl" ? s.localId : "")));
    const added = locals.filter(
      (local) =>
        liveIds.has(local.id) || !entry.some((s) => s.kind === "varDecl" && s.localId === local.id),
    );
    return { ...fn, locals: [...kept, ...added], body: [...live, ...body] };
  }
}

/** The same local, read-only: nothing writes it after its declaration. */
function immutableLocal(local: IrLocal): IrLocal {
  return { ...local, mutable: false };
}

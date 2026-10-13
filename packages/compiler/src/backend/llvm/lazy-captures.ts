import type { IrExpr, IrFunction, IrStmt } from "../../ir/ir.js";
import { everyStmtList } from "../../ir/traverse.js";

/** The local a node rebinds. Writes through the bound reference, such as a
 * field store or an array push, leave the binding unchanged. Catch bindings
 * and rethrow targets are conservatively treated as rebinding. */
function rebound(node: IrStmt | IrExpr): string | null {
  switch (node.kind) {
    case "varDecl":
    case "assign":
    case "forOf":
    case "rethrow":
    case "assignExpr":
    case "incDec":
      return node.localId;
    case "tryCatch":
      return node.catchLocalId;
    default:
      return null;
  }
}

/** A captured parameter that no code rebinds holds its entry value for the
 * whole call, so every environment may observe a box created when the first
 * closure is built instead of on function entry. Paths that never create a
 * closure then allocate no box. The proof follows each capture into nested
 * function bodies; class environments keep the eager box. */
export class LazyCaptures {
  private readonly unchanged = new Map<string, boolean>();
  private readonly stable = new Map<string, Set<string>>();
  private readonly once = new Map<string, Set<string>>();
  private sites: Map<string, { owner: string; captures: string[] }[]> | null = null;

  constructor(private readonly functions: ReadonlyMap<string, IrFunction>) {}

  /** The captures of closure body `fnName` that hold one value for the
   * closure's whole life: at every creation site the captured binding is
   * a parameter that nothing rebinds (see parameters) or, through nesting,
   * such a capture of the creating closure, and nothing rebinds the
   * capture itself. The environment owns that value whenever the body
   * runs, so the body may read it without a reference of its own. */
  stableCaptures(fnName: string): Set<string> {
    const known = this.stable.get(fnName);
    if (known !== undefined) return known;
    const result = new Set<string>();
    // Capture chains follow lexical nesting and cannot cycle; the empty
    // provisional entry only bounds work on malformed input.
    this.stable.set(fnName, result);
    const fn = this.functions.get(fnName);
    const sites = this.creationSites().get(fnName);
    if (fn?.captures === undefined || fn.async || fn.generator || sites === undefined)
      return result;
    fn.captures.forEach((capture, index) => {
      for (const site of sites) {
        const owner = this.functions.get(site.owner);
        const source = site.captures[index];
        if (owner === undefined || source === undefined) return;
        if (
          !this.parameters(owner).has(source) &&
          !this.declaredOnce(owner).has(source) &&
          !this.stableCaptures(site.owner).has(source)
        )
          return;
      }
      if (this.isUnchanged(fnName, capture.localId)) result.add(capture.localId);
    });
    return result;
  }

  /** Boxed locals of `fn` (not parameters) bound by exactly one
   * declaration that nothing else rebinds, here or in nested bodies. Each
   * declaration fills a fresh box once, before any closure can capture it
   * (TDZ bindings are excluded). */
  private declaredOnce(fn: IrFunction): Set<string> {
    const known = this.once.get(fn.name);
    if (known !== undefined) return known;
    const result = new Set<string>();
    this.once.set(fn.name, result);
    if (fn.async || fn.generator) return result;
    const params = new Set(fn.params.map((p) => p.localId));
    const candidates = new Set(
      fn.locals.filter((l) => l.boxed && !l.tdz && !params.has(l.id)).map((l) => l.id),
    );
    if (candidates.size === 0) return result;
    const declarations = new Map<string, number>();
    const visit = (node: IrStmt | IrExpr): boolean => {
      if (node.kind === "varDecl" && candidates.has(node.localId))
        declarations.set(node.localId, (declarations.get(node.localId) ?? 0) + 1);
      return true;
    };
    everyStmtList(fn.body, { stmt: visit, expr: visit });
    const changed = this.rebindings(fn, candidates, true);
    for (const id of candidates) if (declarations.get(id) === 1 && !changed.has(id)) result.add(id);
    return result;
  }

  private creationSites(): Map<string, { owner: string; captures: string[] }[]> {
    if (this.sites !== null) return this.sites;
    const sites = new Map<string, { owner: string; captures: string[] }[]>();
    for (const fn of this.functions.values()) {
      const visit = (node: IrStmt | IrExpr): boolean => {
        if (node.kind === "closure") {
          let list = sites.get(node.fnName);
          if (!list) sites.set(node.fnName, (list = []));
          list.push({ owner: fn.name, captures: node.captures });
        }
        return true;
      };
      everyStmtList(fn.body, { stmt: visit, expr: visit });
    }
    this.sites = sites;
    return sites;
  }

  parameters(fn: IrFunction): Set<string> {
    const result = new Set<string>();
    if (fn.async || fn.generator) return result;
    const locals = new Map(fn.locals.map((local) => [local.id, local]));
    for (const param of fn.params) {
      const local = locals.get(param.localId);
      if (local?.boxed && !local.tdz) result.add(param.localId);
    }
    if (result.size === 0) return result;
    for (const id of this.rebindings(fn, result)) result.delete(id);
    return result;
  }

  /** The subset of `ids` rebound in `fn` or in any function that captures
   * one of them, directly or through further nesting. */
  private rebindings(
    fn: IrFunction,
    ids: ReadonlySet<string>,
    declarationsBind = false,
  ): Set<string> {
    const changed = new Set<string>();
    const nested: { target: string; local: string; source: string }[] = [];
    const visit = (node: IrStmt | IrExpr): boolean => {
      // With `declarationsBind`, declarations are counted separately.
      const target = declarationsBind && node.kind === "varDecl" ? null : rebound(node);
      if (target !== null && ids.has(target)) changed.add(target);
      if (node.kind === "classRef") {
        for (const id of node.captures ?? []) if (ids.has(id)) changed.add(id);
      } else if (node.kind === "closure") {
        const callee = this.functions.get(node.fnName);
        node.captures.forEach((id, index) => {
          if (!ids.has(id)) return;
          const capture = callee?.captures?.[index];
          if (!capture) changed.add(id);
          else nested.push({ target: node.fnName, local: capture.localId, source: id });
        });
      }
      return true;
    };
    everyStmtList(fn.body, { stmt: visit, expr: visit });
    for (const edge of nested) {
      if (!changed.has(edge.source) && !this.isUnchanged(edge.target, edge.local))
        changed.add(edge.source);
    }
    return changed;
  }

  private isUnchanged(fnName: string, localId: string): boolean {
    const key = `${fnName}\0${localId}`;
    const known = this.unchanged.get(key);
    if (known !== undefined) return known;
    // Capture chains follow lexical nesting and cannot cycle; the
    // provisional entry only bounds work on malformed input.
    this.unchanged.set(key, false);
    const fn = this.functions.get(fnName);
    const result = fn !== undefined && this.rebindings(fn, new Set([localId])).size === 0;
    this.unchanged.set(key, result);
    return result;
  }
}

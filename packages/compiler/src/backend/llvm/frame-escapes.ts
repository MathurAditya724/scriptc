/* Frame escapes (stack-objects.ts): the locals whose value provably dies
 * before their function returns, so that an object bound to one can live in
 * the frame.
 *
 * A local stays in the frame when every use of its value does: field and
 * element reads and writes through it (storing into it is fine), length and
 * search operations, identity comparisons, a statement that discards it, and
 * passing it to a parameter that itself stays in its callee's frame
 * (region-ir.ts keepsInFrame). A value that a conditional, a union wrap or
 * narrow, a cast or a sequence passes on takes that expression's fate. A
 * `const` binding of the value in the same function shares the local's fate:
 * it is declared inside the local's scope, so it cannot outlive it.
 *
 * A closure that captures the local keeps it in the frame when the closure
 * itself stays in the frame (it is only invoked, or passed to a parameter
 * that stays in its callee's frame) and its body keeps the captured binding
 * in the frame. The binding's box then never outlives the frame either.
 *
 * Everything else escapes: returning or throwing it, storing the value
 * itself anywhere (a field, an element, a collection, a module global or
 * another binding by assignment), capturing it in a closure that escapes or
 * in a local class, converting it, and every call whose target is not a
 * known function with a proven parameter.
 *
 * Parameter and capture facts are solved optimistically over the call
 * graph, like CallLifetimes: every reference parameter stays in its
 * callee's frame, and every captured binding in its closure's, until a use
 * proves otherwise. Async functions, generators and module code have none,
 * since their frames can outlive a call or are the program's own. */
import type { IrFunction, IrModule } from "../../ir/ir.js";
import {
  children,
  forEachNode,
  keepsInFrame,
  same,
  refType,
  transparent,
  type Node,
} from "./region-ir.js";

export interface FrameEscapes {
  /** The reference locals of `fn` whose value never leaves its frame:
   * never assigned after its declaration, captured only by closures that
   * keep it in the frame, and every use keeping it in the frame. */
  locals(fn: IrFunction): ReadonlySet<string>;
  /** Per function, the reference parameters whose argument stays in the
   * callee's frame. */
  readonly parameters: ReadonlyMap<string, ReadonlySet<number>>;
}

const NO_FUNCTIONS: ReadonlySet<IrFunction> = new Set();

function suspends(fn: IrFunction): boolean {
  return fn.async === true || fn.generator !== undefined || /^%(init\.\d+|main)$/.test(fn.name);
}

/** Parameter and capture facts, solved together (analyzeFrameEscapes). */
interface Facts {
  parameters: Map<string, Set<number>>;
  /** Per lifted function, the captured locals whose value stays in the
   * frame of each invocation of the closure. */
  captures: Map<string, Set<string>>;
}

/** The locals of `fn` that a use lets leave the frame, or that are assigned
 * after their declaration. A local bound by a `const` declaration to
 * another local's value shares its fate. A closure shares the fate of the
 * locals it captures: they stay in the frame only while the closure does
 * and its body keeps them there (Facts.captures). Every other captured
 * binding escapes. */
function escapingLocals(fn: IrFunction, facts: Facts): Set<string> {
  const escaping = new Set<string>();
  const own = new Set(fn.locals.map((l) => l.id));
  const group = new Map<string, string>();
  const find = (id: string): string => {
    let root = id;
    while (group.has(root)) root = group.get(root)!;
    return root;
  };
  const unite = (a: string, b: string): void => {
    const ra = find(a),
      rb = find(b);
    if (ra !== rb) group.set(ra, rb);
  };
  const declared = new Map<string, number>();
  // Captured bindings that a closure node of this function captures.
  const closureCaptured = new Set<string>();
  let closures = 0;
  const parents: Node[] = [];
  /** The fate of the value `node` produces: shared with the binding a
   * `const` declaration gives it, kept by its consumer, or escaping. */
  const fate = (node: Node, id: string): void => {
    let value: Node = node;
    let at = parents.length - 1;
    while (at >= 0 && transparent(value, parents[at])) value = parents[at--]!;
    const parent = at >= 0 ? parents[at] : undefined;
    if (
      parent?.kind === "varDecl" &&
      parent.init !== null &&
      same(parent.init, value) &&
      own.has(parent.localId) &&
      parent.localId !== id
    )
      unite(id, parent.localId);
    else if (!keepsInFrame(value, parent, facts.parameters)) escaping.add(id);
  };
  const walk = (node: Node): void => {
    if (node.kind === "varDecl") declared.set(node.localId, (declared.get(node.localId) ?? 0) + 1);
    if (node.kind === "assign" || node.kind === "assignExpr" || node.kind === "incDec")
      escaping.add(node.localId);
    if (node.kind === "classRef") for (const id of node.captures ?? []) escaping.add(id);
    if (node.kind === "closure") {
      const closure = `%closure.${closures++}`;
      fate(node, closure);
      const kept = facts.captures.get(node.fnName);
      for (const id of node.captures ?? []) {
        closureCaptured.add(id);
        unite(id, closure);
        if (kept?.has(id) !== true) escaping.add(id);
      }
    }
    if (node.kind === "varRef") {
      fate(node, node.localId);
      return;
    }
    const kids: Node[] = [];
    children(node, kids);
    parents.push(node);
    for (const kid of kids) walk(kid);
    parents.pop();
  };
  for (const stmt of fn.body) walk(stmt);
  const lifted = new Set((fn.captures ?? []).map((c) => c.localId));
  for (const local of fn.locals) {
    if (local.boxed === true && !lifted.has(local.id) && !closureCaptured.has(local.id))
      escaping.add(local.id);
    if ((declared.get(local.id) ?? 0) > 1) escaping.add(local.id);
  }
  const roots = new Set<string>();
  for (const id of escaping) roots.add(find(id));
  for (const local of fn.locals) if (roots.has(find(local.id))) escaping.add(local.id);
  return escaping;
}

export function analyzeFrameEscapes(mod: IrModule): FrameEscapes {
  const facts: Facts = { parameters: new Map(), captures: new Map() };
  for (const fn of mod.functions) {
    const safe = new Set<number>();
    const kept = new Set<string>();
    if (!suspends(fn)) {
      fn.params.forEach((param, i) => {
        if (refType(param.type)) safe.add(i);
      });
      for (const capture of fn.captures ?? []) kept.add(capture.localId);
    }
    facts.parameters.set(fn.name, safe);
    facts.captures.set(fn.name, kept);
  }
  // A fact that turns false can make locals escape in the functions that
  // call the function or create its closures, so only those are visited
  // again.
  const dependents = new Map<string, Set<IrFunction>>();
  const depend = (on: string, fn: IrFunction): void => {
    let set = dependents.get(on);
    if (!set) dependents.set(on, (set = new Set()));
    set.add(fn);
  };
  for (const fn of mod.functions)
    forEachNode(fn.body, (node) => {
      if (node.kind === "call") depend(node.callee, fn);
      else if (node.kind === "closure") depend(node.fnName, fn);
    });
  const has = (fn: IrFunction): boolean =>
    facts.parameters.get(fn.name)!.size > 0 || facts.captures.get(fn.name)!.size > 0;
  const queued = new Set(mod.functions.filter(has));
  const queue = [...queued];
  while (queue.length > 0) {
    const fn = queue.pop()!;
    queued.delete(fn);
    if (!has(fn)) continue;
    const escaping = escapingLocals(fn, facts);
    let changed = false;
    const safe = facts.parameters.get(fn.name)!;
    fn.params.forEach((param, i) => {
      if (safe.has(i) && escaping.has(param.localId)) {
        safe.delete(i);
        changed = true;
      }
    });
    const kept = facts.captures.get(fn.name)!;
    for (const id of [...kept])
      if (escaping.has(id)) {
        kept.delete(id);
        changed = true;
      }
    if (changed)
      for (const dependent of dependents.get(fn.name) ?? NO_FUNCTIONS)
        if (!queued.has(dependent) && has(dependent)) {
          queued.add(dependent);
          queue.push(dependent);
        }
  }
  const locals = new Map<string, ReadonlySet<string>>();
  return {
    parameters: facts.parameters,
    locals(fn: IrFunction): ReadonlySet<string> {
      let kept = locals.get(fn.name);
      if (kept === undefined) {
        const set = new Set<string>();
        if (!suspends(fn)) {
          const escaping = escapingLocals(fn, facts);
          for (const local of fn.locals)
            if (refType(local.type) && !escaping.has(local.id)) set.add(local.id);
        }
        locals.set(fn.name, (kept = set));
      }
      return kept;
    },
  };
}

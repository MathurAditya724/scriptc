/* The jsval pass (two-tier design stage S3): dynamic-tier functions compute
 * with jsval values instead of dyn cells.
 *
 * Lowering builds every dynamic operation over `dyn`, the checked-dynamic
 * cell (ScrDyn), where a number is a heap node: each dyn operator result
 * allocates one. This pass rewrites the operator chains of dynamic-tier
 * functions (ir/tiers.ts) to the `js.*` builtins over `jsval`, the
 * NaN-boxed word whose numbers, booleans, undefined and null are
 * immediates:
 *
 * - every dyn operator (`dyn.add`, `dyn.arithmetic`, `dyn.bitwise`,
 *   `dyn.toNumeric`, `dyn.increment`) becomes its `js.*` twin, whose
 *   operands are rewritten as jsvals too, so a chain `a * b + c` allocates
 *   nothing for its intermediate results;
 * - the operator consumers `dyn.compare` and `dyn.toNumberCoerce` take
 *   jsval operands, a number check `dynCheck<f64>` of an operator result
 *   becomes `js.toF64`, and a truthiness test of one tests the jsval;
 * - a static number or boolean operand (`dynFrom<f64>`) becomes an
 *   immediate (`js.fromF64`), a static string or BigInt the same object
 *   under a tag (`js.fromStr`, `js.fromBigInt`: no cell), and any other dyn
 *   operand a cell under the cell tag (`js.fromDyn`: no copy, identity
 *   kept);
 * - an operator result that flows anywhere else (a property store, a call
 *   argument, a dyn local) is boxed back into a cell (`js.toDyn`), exactly
 *   the allocation the dyn operator made before;
 * - a dynamic function whose only references are direct calls from
 *   dynamic functions returns a jsval, so a number it returns is not boxed
 *   (static callers, function values, exports and class members keep the
 *   dyn ABI);
 * - such a function also takes a jsval for each parameter whose callers
 *   mostly pass operator results or static numbers, unless its own reads
 *   of the parameter by dyn consumers box more often than its callers do;
 * - a dyn local becomes a jsval local when the boxing it saves on writes
 *   of operator results outweighs the boxing its reads by dyn consumers add
 *   (loop depth weights both).
 *
 * The rewrite changes representation only: every js builtin implements its
 * dyn twin's JS semantics, including ToPrimitive order and error messages
 * (scr_js_value.c delegates every non-number case to the dyn operator).
 * Static functions are never touched (invariant I1). Captures, containers
 * and the parameters of functions reached other than by direct calls still
 * hold cells until the shaped object model and the dynamic call ABI
 * (stages S4 and S5) replace them.
 *
 * Async functions and generators are rewritten like other functions (their
 * suspensions keep jsvals like any pointer) but keep the dyn result ABI. */
import { exprFunctionReference, moduleFunctionReferences } from "./function-references.js";
import { DYN, JSVAL, type IrExpr, type IrFunction, type IrModule, type IrStmt } from "./ir.js";
import { JsIcSites } from "./js-ic.js";
import {
  everyExprChild,
  everyStmtChild,
  everyStmtList,
  mapExprChildren,
  mapStmtChildren,
} from "./traverse.js";

/** dyn operators whose result is a fresh dynamic value, with their jsval
 * twins. Every argument typed dyn is an operand. */
const PRODUCERS: Readonly<Record<string, string>> = {
  "dyn.add": "js.add",
  "dyn.arithmetic": "js.arithmetic",
  "dyn.bitwise": "js.bitwise",
  "dyn.toNumeric": "js.toNumeric",
  "dyn.increment": "js.increment",
};

/** dyn operators with a static result, with their jsval twins. */
const CONSUMERS: Readonly<Record<string, string>> = {
  "dyn.compare": "js.compare",
  "dyn.toNumberCoerce": "js.toNumberCoerce",
};

function isProducerCall(e: IrExpr): boolean {
  return e.kind === "libCall" && Object.hasOwn(PRODUCERS, e.fn);
}

function isConsumerCall(e: IrExpr): boolean {
  return e.kind === "libCall" && Object.hasOwn(CONSUMERS, e.fn);
}

/** The jsval conversion of a static value that crosses without a cell:
 * numbers and booleans as immediates, strings and BigInts as the static
 * tier's own objects under a tag. */
const STATIC_SOURCES: Readonly<Record<string, string>> = {
  f64: "js.fromF64",
  bool: "js.fromBool",
  string: "js.fromStr",
  bigint: "js.fromBigInt",
};

function isImmediateSource(e: IrExpr): boolean {
  return (
    e.kind === "dynFrom" &&
    e.liveRef === undefined &&
    e.fnName === undefined &&
    Object.hasOwn(STATIC_SOURCES, e.value.type.kind)
  );
}

/** Whether a function's operators are rewritten: every dynamic-tier
 * function. Async functions and generators suspend through LLVM coroutines
 * or fibers, which keep jsval temporaries and locals like any pointer. */
export function jsvalEligible(fn: IrFunction): boolean {
  return fn.tier === "dynamic";
}

/** Rewrite every eligible dynamic-tier function of a module in place.
 * Returns the number of functions that now use jsval. */
export function promoteJsvals(mod: IrModule): number {
  const direct = directCallees(mod);
  const results = new Set<string>();
  for (const fn of mod.functions)
    if (direct.has(fn.name) && fn.returnType.kind === "dyn") results.add(fn.name);
  const sites = new JsIcSites(mod);
  const storesJs = (e: IrExpr): boolean =>
    e.kind === "call" && sites.site(e.callee)?.kind === "set";
  const params = jsvalParams(mod, direct, results, storesJs);
  let count = 0;
  for (const fn of mod.functions)
    if (jsvalEligible(fn) && promoteFunction(fn, results, params, storesJs)) count++;
  for (const fn of mod.functions) if (results.has(fn.name)) fn.returnType = JSVAL;
  return count;
}

/** Dynamic-tier functions whose ABI the pass may change, so a number they
 * return or take is not boxed: eligible functions whose every reference is
 * a direct call from a dynamic-tier function (static callers keep their
 * exact code, I1). Function values, library exports, the entry and class
 * members (`%<class>.<member>`, which vtables and the runtime reach by
 * name) keep the dyn ABI. */
function directCallees(mod: IrModule): Set<string> {
  const classPrefixes = (mod.classes ?? []).map((cls) => `%${cls.name}.`);
  const results = new Set<string>();
  for (const fn of mod.functions) {
    // An async function's callers receive a promise and a generator's a
    // generator object: only synchronous functions return their result.
    if (!jsvalEligible(fn) || fn.async !== undefined || fn.generator !== undefined) continue;
    if (fn.name.includes(".") && !fn.name.startsWith("%dyn.")) continue;
    if (classPrefixes.some((prefix) => fn.name.startsWith(prefix))) continue;
    results.add(fn.name);
  }
  if (results.size === 0) return results;
  for (const name of moduleFunctionReferences(mod)) results.delete(name);
  for (const fn of mod.functions) {
    const dynamic = fn.tier === "dynamic";
    everyStmtList(fn.body, {
      expr: (e) => {
        if (e.kind === "call" && !dynamic) results.delete(e.callee);
        const referenced = exprFunctionReference(e);
        if (referenced !== undefined) results.delete(referenced);
        if (e.kind === "dynFrom" && e.fnName !== undefined) results.delete(e.fnName);
        return true;
      },
      stmt: () => true,
    });
  }
  return results;
}

/** The parameters of direct callees that take a jsval, by position. A dyn
 * parameter of a direct callee other than a library helper (`%dyn.*`,
 * whose calls the inline caches emit) is a candidate. Its credit is the
 * share of its arguments, weighted by the callers' loop depth, that the
 * callers compute as jsvals (operator results, jsval results and static
 * numbers): the boxing a call saves. promotableLocals weighs it against
 * the callee's reads of the parameter by dyn consumers. */
function jsvalParams(
  mod: IrModule,
  direct: ReadonlySet<string>,
  results: ReadonlySet<string>,
  storesJs: (e: IrExpr) => boolean,
): Map<string, boolean[]> {
  const byName = new Map<string, IrFunction>();
  const passed = new Map<string, { total: number[]; js: number[] }>();
  for (const fn of mod.functions) {
    byName.set(fn.name, fn);
    if (!direct.has(fn.name) || fn.name.startsWith("%dyn.")) continue;
    if (!fn.params.some((p) => p.type.kind === "dyn")) continue;
    passed.set(fn.name, { total: fn.params.map(() => 0), js: fn.params.map(() => 0) });
  }
  const params = new Map<string, boolean[]>();
  if (passed.size === 0) return params;
  const jsArgument = (e: IrExpr): boolean =>
    isProducerCall(e) || isImmediateSource(e) || (e.kind === "call" && results.has(e.callee));
  for (const fn of mod.functions) {
    if (fn.tier !== "dynamic") continue;
    everyWeightedExpr(fn.body, (e, weight) => {
      const counts = e.kind === "call" ? passed.get(e.callee) : undefined;
      if (counts === undefined || e.kind !== "call") return;
      e.args.forEach((arg, i) => {
        if (i >= counts.total.length || arg.type.kind !== "dyn") return;
        counts.total[i]! += weight;
        if (jsArgument(arg)) counts.js[i]! += weight;
      });
    });
  }
  const producer = (e: IrExpr): boolean =>
    isProducerCall(e) || (e.kind === "call" && results.has(e.callee));
  for (const [name, counts] of passed) {
    const fn = byName.get(name)!;
    const credits = new Map<string, number>();
    fn.params.forEach((p, i) => {
      if (p.type.kind === "dyn" && counts.js[i]! > 0)
        credits.set(p.localId, counts.js[i]! / counts.total[i]!);
    });
    if (credits.size === 0) continue;
    const promoted = promotableLocals(fn, producer, results.has(name), storesJs, credits);
    const js = fn.params.map((p) => credits.has(p.localId) && promoted.has(p.localId));
    if (js.includes(true)) params.set(name, js);
  }
  return params;
}

/** Visit every expression of a body with its loop weight. */
function everyWeightedExpr(body: IrStmt[], visit: (e: IrExpr, weight: number) => void): void {
  const expr = (e: IrExpr, weight: number): void => {
    visit(e, weight);
    everyExprChild(
      e,
      (child) => {
        expr(child, weight);
        return true;
      },
      (child) => {
        stmt(child, weight);
        return true;
      },
    );
  };
  const stmt = (s: IrStmt, weight: number): void => {
    const inner =
      s.kind === "while" || s.kind === "doWhile" || s.kind === "for" || s.kind === "forOf"
        ? Math.min(weight * LOOP_WEIGHT, MAX_WEIGHT)
        : weight;
    everyStmtChild(
      s,
      (child) => {
        expr(child, inner);
        return true;
      },
      (child) => {
        stmt(child, inner);
        return true;
      },
    );
  };
  for (const s of body) stmt(s, 1);
}

/* ── local promotion ─────────────────────────────────────────────────── */

const LOOP_WEIGHT = 8;
const MAX_WEIGHT = 8 ** 6;

interface LocalCost {
  /** Boxing a jsval local saves: writes of operator results (and
   * immediates), weighted by loop depth. */
  saved: number;
  /** Boxing it adds: reads by dyn consumers, weighted the same way. */
  added: number;
}

/** The dyn locals of a function that become jsval locals. `producer`
 * tells which dyn expressions the rewrite computes as jsvals. Parameters
 * are candidates only with a credit (jsvalParams); `jsParams` lists the
 * arguments that calls pass as jsvals. */
function promotableLocals(
  fn: IrFunction,
  producer: (e: IrExpr) => boolean,
  jsResult: boolean,
  storesJs: (e: IrExpr) => boolean,
  credits: ReadonlyMap<string, number> = new Map(),
  jsParams: ReadonlyMap<string, readonly boolean[]> = new Map(),
): Set<string> {
  const candidates = new Map<string, LocalCost>();
  for (const local of fn.locals) {
    if (local.type.kind === "dyn" && local.boxed === undefined && local.tdz === undefined)
      candidates.set(local.id, { saved: 0, added: 0 });
  }
  for (const p of fn.params) {
    const cost = candidates.get(p.localId);
    const credit = credits.get(p.localId);
    if (cost === undefined || credit === undefined) candidates.delete(p.localId);
    else cost.saved += credit;
  }
  for (const c of fn.captures ?? []) candidates.delete(c.localId);
  for (const c of fn.classCaptures ?? []) candidates.delete(c.localId);
  if (candidates.size === 0) return new Set();
  const blocked = new Set<string>();
  const write = (id: string, value: IrExpr | null, weight: number): void => {
    const cost = candidates.get(id);
    if (cost === undefined) return;
    if (value === null) {
      // A declared-only dyn binding is an uninitialized trap (ir/build.ts).
      blocked.add(id);
      return;
    }
    if (producer(value) || isImmediateSource(value)) cost.saved += weight;
  };
  /* `js`: the expression is an operand the rewrite turns into a jsval. */
  const expr = (e: IrExpr, js: boolean, weight: number): void => {
    switch (e.kind) {
      case "varRef": {
        const cost = candidates.get(e.localId);
        if (cost !== undefined && !js) cost.added += weight;
        return;
      }
      case "assignExpr":
        write(e.localId, e.value, weight);
        expr(e.value, false, weight);
        // The assignment's own value is read where it stands.
        if (!js && candidates.has(e.localId)) candidates.get(e.localId)!.added += weight;
        return;
      case "libCall":
        if (isProducerCall(e) || isConsumerCall(e)) {
          for (const arg of e.args) expr(arg, arg.type.kind === "dyn", weight);
          return;
        }
        break;
      case "dynCheck":
        if (e.type.kind === "f64" && e.preserveRefs === undefined) {
          expr(e.value, true, weight);
          return;
        }
        break;
      case "toBool":
        if (e.operand.type.kind === "dyn") {
          expr(e.operand, true, weight);
          return;
        }
        break;
      case "call": {
        // An inline-cache store takes its value as a jsval (S4).
        if (storesJs(e)) {
          expr(e.args[0]!, false, weight);
          expr(e.args[1]!, true, weight);
          return;
        }
        const js = jsParams.get(e.callee);
        if (js !== undefined) {
          e.args.forEach((arg, i) => expr(arg, js[i] === true, weight));
          return;
        }
        break;
      }
      default:
        break;
    }
    blockExprReferences(e);
    everyExprChild(
      e,
      (child) => {
        expr(child, false, weight);
        return true;
      },
      (s) => {
        stmt(s, weight);
        return true;
      },
    );
  };
  /** Locals referenced other than by reads and plain writes (increments,
   * loop and catch bindings, rethrows, closure captures) keep dyn. */
  const blockExprReferences = (e: IrExpr): void => {
    if (e.kind === "incDec") blocked.add(e.localId);
    else if (e.kind === "closure") for (const id of e.captures) blocked.add(id);
    else if (e.kind === "classRef") for (const id of e.captures ?? []) blocked.add(id);
  };
  const blockStmtReferences = (s: IrStmt): void => {
    if (s.kind === "forOf" || s.kind === "rethrow") blocked.add(s.localId);
    else if (s.kind === "tryCatch" && s.catchLocalId !== null) blocked.add(s.catchLocalId);
  };
  const stmt = (s: IrStmt, weight: number): void => {
    switch (s.kind) {
      case "exprStmt":
        // A discarded sequence result (a compound assignment statement)
        // is never boxed.
        if (discardedSequence(s.expr)) {
          for (const inner of s.expr.stmts) stmt(inner, weight);
          expr(s.expr.result, true, weight);
          return;
        }
        blockStmtReferences(s);
        expr(s.expr, false, weight);
        return;
      case "return":
        if (s.value !== null) expr(s.value, jsResult && s.value.type.kind === "dyn", weight);
        return;
      case "varDecl":
        write(s.localId, s.init, weight);
        if (s.init !== null) expr(s.init, false, weight);
        return;
      case "assign":
        if (s.initializes !== undefined) blocked.add(s.localId);
        write(s.localId, s.value, weight);
        expr(s.value, false, weight);
        return;
      case "while":
      case "doWhile":
      case "for":
      case "forOf": {
        blockStmtReferences(s);
        const inner = Math.min(weight * LOOP_WEIGHT, MAX_WEIGHT);
        everyStmtChild(
          s,
          (child) => {
            expr(child, false, inner);
            return true;
          },
          (child) => {
            stmt(child, inner);
            return true;
          },
        );
        return;
      }
      default:
        blockStmtReferences(s);
        everyStmtChild(
          s,
          (child) => {
            expr(child, false, weight);
            return true;
          },
          (child) => {
            stmt(child, weight);
            return true;
          },
        );
    }
  };
  for (const s of fn.body) stmt(s, 1);
  const promoted = new Set<string>();
  for (const [id, cost] of candidates)
    if (!blocked.has(id) && cost.saved > cost.added) promoted.add(id);
  return promoted;
}

/** A statement-level sequence whose result nothing reads. */
function discardedSequence(e: IrExpr): e is Extract<IrExpr, { kind: "seqExpr" }> {
  return e.kind === "seqExpr" && e.generatorDelegate === undefined && e.diverges === undefined;
}

/* ── the rewrite ─────────────────────────────────────────────────────── */

function promoteFunction(
  fn: IrFunction,
  results: ReadonlySet<string>,
  params: ReadonlyMap<string, readonly boolean[]>,
  storesJs: (e: IrExpr) => boolean,
): boolean {
  const resultCall = (e: IrExpr): boolean => e.kind === "call" && results.has(e.callee);
  const operatorCall = (e: IrExpr): boolean => isProducerCall(e);
  const promoted = promotableLocals(
    fn,
    (e) => operatorCall(e) || resultCall(e),
    results.has(fn.name),
    storesJs,
    new Map(),
    params,
  );
  const ownParams = params.get(fn.name);
  fn.params.forEach((p, i) => {
    if (ownParams?.[i] === true) promoted.add(p.localId);
  });
  const ownResult = results.has(fn.name);
  let changed = ownParams !== undefined;
  const producesJs = (e: IrExpr): boolean =>
    operatorCall(e) ||
    resultCall(e) ||
    ((e.kind === "varRef" || e.kind === "assignExpr") && promoted.has(e.localId));
  const libCall = (fn: string, args: IrExpr[], e: IrExpr, type = JSVAL): IrExpr => ({
    kind: "libCall",
    fn: fn as Extract<IrExpr, { kind: "libCall" }>["fn"],
    args,
    type,
    loc: e.loc,
  });
  /** A call's arguments, as jsvals where the callee takes them so. */
  const callArgs = (e: Extract<IrExpr, { kind: "call" }>): IrExpr[] => {
    const js = params.get(e.callee);
    return e.args.map((arg, i) => (js?.[i] === true ? toJs(arg) : rewrite(arg)));
  };
  /** A dyn-typed expression as a jsval. */
  const toJs = (e: IrExpr): IrExpr => {
    changed = true;
    if (e.kind === "call" && results.has(e.callee)) return { ...e, args: callArgs(e), type: JSVAL };
    if (e.kind === "libCall" && Object.hasOwn(PRODUCERS, e.fn)) {
      return libCall(
        PRODUCERS[e.fn]!,
        e.args.map((arg) => (arg.type.kind === "dyn" ? toJs(arg) : rewrite(arg))),
        e,
      );
    }
    if (isImmediateSource(e) && e.kind === "dynFrom") {
      const value = rewrite(e.value);
      return libCall(STATIC_SOURCES[value.type.kind]!, [value], e);
    }
    if (e.kind === "varRef" && promoted.has(e.localId)) return { ...e, type: JSVAL };
    if (e.kind === "assignExpr" && promoted.has(e.localId))
      return { ...e, value: toJs(e.value), type: JSVAL };
    return libCall("js.fromDyn", [rewrite(e)], e);
  };
  /** Any expression, in a position expecting its own type. */
  const rewrite = (e: IrExpr): IrExpr => {
    if (e.kind === "libCall" && Object.hasOwn(CONSUMERS, e.fn)) {
      changed = true;
      return libCall(
        CONSUMERS[e.fn]!,
        e.args.map((arg) => (arg.type.kind === "dyn" ? toJs(arg) : rewrite(arg))),
        e,
        e.type,
      );
    }
    if (
      e.kind === "dynCheck" &&
      e.type.kind === "f64" &&
      e.preserveRefs === undefined &&
      producesJs(e.value)
    )
      return libCall("js.toF64", [toJs(e.value)], e, e.type);
    if (e.kind === "toBool" && e.operand.type.kind === "dyn" && producesJs(e.operand))
      return { ...e, operand: toJs(e.operand) };
    if (e.type.kind === "dyn" && producesJs(e)) return libCall("js.toDyn", [toJs(e)], e, DYN);
    if (e.kind === "call" && params.has(e.callee)) {
      changed = true;
      return { ...e, args: callArgs(e) };
    }
    return mapExprChildren(e, rewrite, rewriteStmt);
  };
  const rewriteStmt = (s: IrStmt): IrStmt => {
    if (s.kind === "return" && ownResult && s.value !== null) return { ...s, value: toJs(s.value) };
    // A discarded result stays a jsval: nothing boxes it.
    if (s.kind === "exprStmt" && producesJs(s.expr)) return { ...s, expr: toJs(s.expr) };
    if (s.kind === "exprStmt" && discardedSequence(s.expr) && producesJs(s.expr.result)) {
      const result = toJs(s.expr.result);
      return {
        ...s,
        expr: { ...s.expr, stmts: s.expr.stmts.map(rewriteStmt), result, type: result.type },
      };
    }
    if (s.kind === "varDecl" && promoted.has(s.localId) && s.init !== null)
      return { ...s, init: toJs(s.init) };
    if (s.kind === "assign" && promoted.has(s.localId)) return { ...s, value: toJs(s.value) };
    return mapStmtChildren(s, rewrite, rewriteStmt);
  };
  const body = fn.body.map(rewriteStmt);
  if (!changed) return false;
  fn.body = body;
  for (const local of fn.locals) if (promoted.has(local.id)) local.type = JSVAL;
  for (const p of fn.params) if (promoted.has(p.localId)) p.type = JSVAL;
  return true;
}

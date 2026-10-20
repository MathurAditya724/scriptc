/* Whole-program stack-trace gate (see observesStacks). Pure function of the
 * IR module; the emitter keeps a source frame in every function only when
 * it answers true. */
import { exprFunctionReference, moduleFunctionReferences } from "../ir/function-references.js";
import { MAY_THROW_LIB_FNS } from "../ir/builtin-effects.js";
import type { IrExpr, IrFunction, IrModule, IrStmt } from "../ir/ir.js";
import { MAY_THROW_ARR_METHODS } from "../ir/ir.js";
import { everyExprChild, everyStmtChild, everyStmtList } from "../ir/traverse.js";
import { unreachableStatements } from "./may-throw.js";
import type { PublishedTypes } from "./publication.js";
import { writesPublished } from "./publication.js";

/** Lib calls that read a captured stack trace. */
const STACK_READS: ReadonlySet<string> = new Set(["error.stack"]);

/** A typed `error.stack` read, or a `stack` read on a checked-dynamic
 * value, which reaches an error's own `stack` accessor. */
function readsStack(expr: IrExpr): boolean {
  if (expr.kind === "libCall") return STACK_READS.has(expr.fn);
  return expr.kind === "dynKeyGet" && expr.key.kind === "strLit" && expr.key.value === "stack";
}

function containsStackRead(fn: IrFunction): boolean {
  return !everyStmtList(fn.body, { stmt: () => true, expr: (expr) => !readsStack(expr) });
}

/** Visit every expression of `body` that execution can reach: statements
 * after one that cannot complete normally in the same list are skipped. */
function visitLiveExprs(body: IrStmt[], visit: (expr: IrExpr) => void): void {
  const dead = unreachableStatements(body);
  const expr = (node: IrExpr): boolean => {
    visit(node);
    return everyExprChild(node, expr, stmt);
  };
  const stmt = (node: IrStmt): boolean => dead.has(node) || everyStmtChild(node, expr, stmt);
  body.every(stmt);
}

/** Whether the program can read a captured stack trace, which is what makes
 * every function keep a source frame. A read counts when it can execute:
 * it sits in live code of a function reachable from the module's roots (its
 * entry, library exports, class prototype helpers and every class's
 * methods) through live code. Code after a statement that cannot complete
 * normally is not live: production builds of libraries such as React's
 * Flight server keep development-only stack parsing behind `throw` stubs,
 * and those reads must not cost every call of the program a frame.
 * Programs without any stack read answer false without the walk. */
export function observesStacks(mod: IrModule): boolean {
  if (!mod.functions.some(containsStackRead)) return false;
  const byName = new Map(mod.functions.map((fn) => [fn.name, fn]));
  const classNames = new Set((mod.classes ?? []).map((cls) => cls.name));
  const pending: string[] = [...moduleFunctionReferences(mod)];
  // Class methods, accessors and constructors are reachable through
  // dispatch the IR does not name per site: all of them are roots.
  for (const fn of mod.functions) {
    if (!fn.name.startsWith("%")) continue;
    for (let dot = fn.name.indexOf("."); dot !== -1; dot = fn.name.indexOf(".", dot + 1)) {
      if (classNames.has(fn.name.slice(1, dot))) {
        pending.push(fn.name);
        break;
      }
    }
  }
  const reached = new Set<string>();
  let observed = false;
  while (pending.length > 0 && !observed) {
    const name = pending.pop()!;
    if (reached.has(name)) continue;
    reached.add(name);
    const fn = byName.get(name);
    if (fn === undefined) continue;
    visitLiveExprs(fn.body, (expr) => {
      if (readsStack(expr)) observed = true;
      if (expr.kind === "call" && !reached.has(expr.callee)) pending.push(expr.callee);
      const referenced = exprFunctionReference(expr);
      if (referenced !== undefined && !reached.has(referenced)) pending.push(referenced);
    });
  }
  return observed;
}

/** Expressions that neither create an Error nor throw one by themselves.
 * Calls, `new` and virtual calls are capture-free when their callees are. */
const CAPTURE_FREE_EXPRS: ReadonlySet<IrExpr["kind"]> = new Set([
  "numLit",
  "boolLit",
  "strLit",
  "unitLit",
  "varRef",
  "incDec",
  "assignExpr",
  "bin",
  "unary",
  "logical",
  "ternary",
  "nullish",
  "toBool",
  "fieldGet",
  "recordGet",
  "arrayGet",
  "arrayHas",
  "arrayState",
  "strCmp",
  "strEq",
  "strConcat",
  "upcast",
  "unionDisc",
  "unionIsTag",
  "unionEq",
  "instanceOf",
  "recordLit",
  "arrayLit",
  "unionWrap",
  "unionNarrow",
  "libCall",
  "arrIntrinsic",
  "call",
  "new",
  "virtualCall",
]);

/** Statements that neither create an Error nor throw one by themselves. */
const CAPTURE_FREE_STMTS: ReadonlySet<IrStmt["kind"]> = new Set([
  "varDecl",
  "assign",
  "exprStmt",
  "if",
  "while",
  "doWhile",
  "for",
  "switch",
  "block",
  "return",
  "break",
  "continue",
  "fieldSet",
  "recordSet",
  "arraySet",
]);

/** Functions whose frame no stack capture can ever include: a capture runs
 * where an Error is created (by the program or by a throwing runtime
 * operation), and these functions only perform operations from a fixed
 * list that never create one and only call functions of the same kind.
 * Their frames are therefore never observable and the emitter omits them,
 * which keeps small leaf methods and helpers free of the per-call frame
 * push in programs that read stacks. Recursive functions (the stack guard
 * throws RangeError), async and generator bodies, and every function of a
 * worker program keep their frames. */
export function captureFreeFunctions(
  mod: IrModule,
  stackChecks: ReadonlySet<string> | null,
  published: PublishedTypes | null,
): Set<string> {
  const free = new Set<string>();
  if (mod.workers === true) return free;
  const methodImpls = new Map<string, string[]>();
  for (const cls of mod.classes ?? []) {
    for (const m of cls.methods ?? []) {
      let list = methodImpls.get(m);
      if (!list) methodImpls.set(m, (list = []));
      list.push(`%${cls.name}.${m}`);
    }
  }
  const tdzGlobals = new Set((mod.globals ?? []).filter((g) => g.tdz).map((g) => g.id));
  const callees = new Map<string, string[]>();
  for (const fn of mod.functions) {
    if (fn.async === true || fn.generator !== undefined || stackChecks?.has(fn.name)) continue;
    const tdz = new Set([...tdzGlobals, ...fn.locals.filter((l) => l.tdz).map((l) => l.id)]);
    const calls: string[] = [];
    const bigint = (e: IrExpr): boolean => e.type.kind === "bigint";
    const expr = (e: IrExpr): boolean => {
      if (!CAPTURE_FREE_EXPRS.has(e.kind)) return false;
      switch (e.kind) {
        case "varRef":
        case "incDec":
        case "assignExpr":
          if (tdz.has(e.localId)) return false;
          break;
        case "bin":
          // BigInt division and remainder by zero throw RangeError.
          if (bigint(e) || bigint(e.left) || bigint(e.right)) return false;
          break;
        case "unary":
          if (bigint(e) || bigint(e.operand)) return false;
          break;
        case "libCall":
          // Math functions only: they neither throw nor call back.
          if (!e.fn.startsWith("math.") || MAY_THROW_LIB_FNS.has(e.fn)) return false;
          break;
        case "arrIntrinsic": {
          // Methods that cannot throw, over numbers, booleans or strings
          // (no element conversion can run program code) and without a
          // callback argument.
          const elem = e.receiver.type.kind === "array" ? e.receiver.type.elem.kind : null;
          if (
            MAY_THROW_ARR_METHODS.has(e.method) ||
            (elem !== "f64" && elem !== "bool" && elem !== "string") ||
            e.args.some((arg) => arg.type.kind === "func")
          )
            return false;
          break;
        }
        case "call":
          calls.push(e.callee);
          break;
        case "new":
          calls.push(`%${e.className}.constructor`);
          break;
        case "virtualCall": {
          const impls = methodImpls.get(e.method);
          if (impls === undefined) return false;
          calls.push(...impls);
          break;
        }
      }
      return everyExprChild(e, expr, stmt);
    };
    const stmt = (s: IrStmt): boolean => {
      if (!CAPTURE_FREE_STMTS.has(s.kind)) return false;
      if (s.kind === "assign" && tdz.has(s.localId)) return false;
      if (published !== null && writesPublished(published, s)) return false;
      return everyStmtChild(s, expr, stmt);
    };
    if (fn.body.every(stmt)) callees.set(fn.name, calls);
  }
  // Drop candidates that call a function outside the set until none do.
  for (const name of callees.keys()) free.add(name);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, calls] of callees) {
      if (free.has(name) && !calls.every((callee) => free.has(callee))) {
        free.delete(name);
        changed = true;
      }
    }
  }
  return free;
}

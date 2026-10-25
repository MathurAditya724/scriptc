import type { IrExpr, IrFunction, IrStmt } from "../../ir/ir.js";
import type { IntegerRanges } from "../../ir/integer-ranges.js";
import { integerArithmeticRange, type IntegerRange } from "../../ir/integer-ranges.js";
import { everyExprChild, everyStmtChild, everyStmtList } from "../../ir/traverse.js";
import { isStableReceiverOperand } from "../../ir/analysis.js";
import { byteNumberAccess } from "../../ir/byte-numbers.js";

interface Extent {
  receiver: string;
  offset: number;
}
interface Bound extends Extent {
  counter: string;
  minimum: number;
}
type Node = IrExpr | IrStmt;

/** Relational proofs for fixed typed-array lengths. Cached lengths retain
 * their receiver identity only when that binding is never reassigned.
 * Loops may use offsets in either direction, but both index integrality
 * and receiver stability are established separately from the relation. */
export function findBytesBounds(fn: IrFunction, ranges: IntegerRanges): ReadonlySet<Node> {
  const proved = new Map<Node, boolean>();
  if (fn.async || fn.generator || !fn.locals.some((local) => local.type.kind === "bytes"))
    return new Set();
  const locals = new Map(fn.locals.map((l) => [l.id, l]));
  const captured = new Set(
    [...(fn.captures ?? []), ...(fn.classCaptures ?? [])].map((c) => c.localId),
  );
  const changed = new Set<string>();
  const initializers = new Map<string, IrExpr>();
  everyStmtList(fn.body, {
    expr: (e) => {
      if (e.kind === "assignExpr" || e.kind === "incDec") changed.add(e.localId);
      return true;
    },
    stmt: (s) => {
      if (s.kind === "assign" || s.kind === "forOf") changed.add(s.localId);
      if (s.kind === "varDecl" && s.init) initializers.set(s.localId, s.init);
      return true;
    },
  });
  const eligible = (id: string): boolean => {
    const local = locals.get(id);
    return local !== undefined && !local.boxed && !local.tdz && !captured.has(id);
  };
  const cached = new Map<string, Extent | null>();
  const resolving = new Set<string>();
  function extent(e: IrExpr, cache: boolean): Extent | null {
    if (
      e.kind === "bytesIntrinsic" &&
      (e.method === "length" ||
        (e.method === "byteLength" &&
          e.receiver.type.kind === "bytes" &&
          (e.receiver.type.elem === "u8" || e.receiver.type.elem === "u8c"))) &&
      e.receiver.kind === "varRef" &&
      eligible(e.receiver.localId) &&
      (!cache || !changed.has(e.receiver.localId))
    )
      return { receiver: e.receiver.localId, offset: 0 };
    if (e.kind === "varRef" && eligible(e.localId) && !changed.has(e.localId)) {
      const previous = cached.get(e.localId);
      if (previous !== undefined) return previous;
      const init = initializers.get(e.localId);
      if (!init || resolving.has(e.localId)) return null;
      resolving.add(e.localId);
      const result = extent(init, true);
      resolving.delete(e.localId);
      cached.set(e.localId, result);
      return result;
    }
    if (
      e.kind === "bin" &&
      (e.op === "+" || e.op === "-") &&
      e.right.kind === "numLit" &&
      Number.isSafeInteger(e.right.value) &&
      ranges.get(e)
    ) {
      const left = extent(e.left, cache);
      const offset = left ? left.offset + (e.op === "+" ? e.right.value : -e.right.value) : NaN;
      if (left && Number.isSafeInteger(offset)) return { receiver: left.receiver, offset };
    }
    return null;
  }
  function affine(e: IrExpr, counter: string): number | null {
    if (e.kind === "varRef" && e.localId === counter) return 0;
    if (
      e.kind !== "bin" ||
      (e.op !== "+" && e.op !== "-") ||
      e.right.kind !== "numLit" ||
      !Number.isSafeInteger(e.right.value)
    )
      return null;
    const left = affine(e.left, counter);
    if (left === null) return null;
    const result = left + (e.op === "+" ? e.right.value : -e.right.value);
    return Number.isSafeInteger(result) ? result : null;
  }
  function affineRange(e: IrExpr, bound: Bound): IntegerRange | null {
    if (e.kind === "varRef" && e.localId === bound.counter) {
      const max = Number.MAX_SAFE_INTEGER + bound.offset - 1;
      return Number.isSafeInteger(max) && bound.minimum <= max ? { min: bound.minimum, max } : null;
    }
    if (
      e.kind !== "bin" ||
      (e.op !== "+" && e.op !== "-") ||
      e.right.kind !== "numLit" ||
      !Number.isSafeInteger(e.right.value)
    )
      return null;
    const left = affineRange(e.left, bound);
    return left
      ? integerArithmeticRange(e.op, left, { min: e.right.value, max: e.right.value })
      : null;
  }
  function stable(body: IrStmt[], receiver: string, counter: string): boolean {
    return everyStmtList(body, {
      expr: (e) => {
        if (
          (e.kind === "assignExpr" || e.kind === "incDec") &&
          (e.localId === receiver || e.localId === counter)
        )
          return false;
        return isStableReceiverOperand(e, receiver);
      },
      stmt: (s) => {
        if (s.kind === "assign" && (s.localId === receiver || s.localId === counter)) return false;
        switch (s.kind) {
          case "varDecl":
          case "assign":
          case "exprStmt":
          case "bytesSet":
          case "if":
          case "block":
          case "for":
          case "while":
          case "doWhile":
          case "break":
          case "continue":
          case "return":
            return true;
          default:
            return false;
        }
      },
    });
  }
  function loopBound(s: IrStmt & { kind: "for" }): Bound | null {
    if (
      s.init?.kind !== "varDecl" ||
      !s.init.init ||
      !eligible(s.init.localId) ||
      s.cond?.kind !== "bin"
    )
      return null;
    const counter = s.init.localId;
    let right = s.cond.right,
      op: string = s.cond.op;
    if (s.cond.left.kind !== "varRef" || s.cond.left.localId !== counter) {
      if (right.kind !== "varRef" || right.localId !== counter) return null;
      right = s.cond.left;
      op = ({ "<": ">", "<=": ">=", ">": "<", ">=": "<=" } as Record<string, string>)[op] ?? "";
    }
    const update = s.update;
    let step = 0;
    if (
      update?.kind === "assign" &&
      update.localId === counter &&
      update.value.kind === "bin" &&
      update.value.left.kind === "varRef" &&
      update.value.left.localId === counter &&
      update.value.right.kind === "numLit"
    ) {
      step =
        update.value.op === "+"
          ? update.value.right.value
          : update.value.op === "-"
            ? -update.value.right.value
            : 0;
    } else if (
      update?.kind === "exprStmt" &&
      update.expr.kind === "incDec" &&
      update.expr.localId === counter
    )
      step = update.expr.op === "+" ? 1 : -1;
    if (!Number.isSafeInteger(step) || step === 0) return null;
    let result: Bound | null = null;
    if (step > 0 && (op === "<" || op === "<=")) {
      const length = extent(right, false),
        start = ranges.get(s.init.init);
      if (length && start)
        result = {
          ...length,
          counter,
          offset: length.offset + (op === "<=" ? 1 : 0),
          minimum: start.min,
        };
    } else if (
      step < 0 &&
      (op === ">" || op === ">=") &&
      right.kind === "numLit" &&
      Number.isFinite(right.value)
    ) {
      const start = extent(s.init.init, false);
      if (start)
        result = {
          ...start,
          counter,
          offset: start.offset + 1,
          minimum: op === ">" ? Math.floor(right.value) + 1 : Math.ceil(right.value),
        };
    }
    return result && stable(s.body, result.receiver, counter) ? result : null;
  }
  function access(node: Node, array: IrExpr, index: IrExpr, active: Bound[], width: number): void {
    const integer = ranges.get(index);
    let safe = false;
    if (array.kind === "varRef" && eligible(array.localId)) {
      for (const bound of active) {
        if (array.localId !== bound.receiver) continue;
        if (!integer && !affineRange(index, bound)) continue;
        const offset = affine(index, bound.counter);
        if (
          offset !== null &&
          bound.minimum + offset >= 0 &&
          bound.offset + offset + width - 1 <= 0
        ) {
          safe = true;
          break;
        }
      }
    }
    proved.set(node, (proved.get(node) ?? true) && safe);
  }
  function expr(e: IrExpr, active: Bound[]): boolean {
    if (e.kind === "bytesIntrinsic" && e.method === "get" && e.args[0])
      access(e, e.receiver, e.args[0], active, 1);
    const numeric = byteNumberAccess(e);
    if (numeric && e.kind === "bytesIntrinsic")
      access(e, e.receiver, e.args[numeric.offsetArg]!, active, numeric.width);
    return everyExprChild(
      e,
      (child) => expr(child, active),
      (child) => stmt(child, active),
    );
  }
  function stmt(s: IrStmt, active: Bound[]): boolean {
    if (s.kind === "bytesSet") access(s, s.arr, s.index, active, 1);
    if (s.kind === "for") {
      if (s.init) stmt(s.init, active);
      if (s.cond) expr(s.cond, active);
      if (s.update) stmt(s.update, active);
      const bound = loopBound(s);
      const body = bound ? [...active, bound] : active;
      return s.body.every((child) => stmt(child, body));
    }
    return everyStmtChild(
      s,
      (child) => expr(child, active),
      (child) => stmt(child, active),
    );
  }
  fn.body.every((s) => stmt(s, []));
  return new Set([...proved].filter(([, safe]) => safe).map(([node]) => node));
}

import type { IntegerRange } from "./integer-ranges.js";
import type { IrExpr, IrLocal, IrStmt } from "./ir.js";
import { everyExprChild, everyStmtChild } from "./traverse.js";

function increment(id: string, value: IrExpr): number | null {
  if (
    value.kind !== "bin" ||
    value.left.kind !== "varRef" ||
    value.left.localId !== id ||
    value.right.kind !== "numLit" ||
    !Number.isSafeInteger(value.right.value) ||
    Object.is(value.right.value, -0)
  )
    return null;
  return value.op === "+" ? value.right.value : value.op === "-" ? -value.right.value : null;
}

/** The counter step `counter + s` (or `counter - s`) adds on each update
 * when `s` is a binding: its operand and sign. A constant step is
 * `increment`'s. */
function variableIncrement(id: string, value: IrExpr): { localId: string; sign: 1 | -1 } | null {
  if (
    value.kind !== "bin" ||
    value.left.kind !== "varRef" ||
    value.left.localId !== id ||
    value.right.kind !== "varRef" ||
    value.right.localId === id ||
    (value.op !== "+" && value.op !== "-")
  )
    return null;
  return { localId: value.right.localId, sign: value.op === "+" ? 1 : -1 };
}

/** Bound secondary cursors by a finite ascending loop's maximum iteration
 * count. Sum all syntactic updates, including both sides of branches, so
 * filtering, breaks and continues can only reduce the budget. A nested
 * loop or opaque control region invalidates the bindings it writes.
 *
 * The counter's step is a positive integer literal or a binding the loop
 * never writes whose entry fact is a positive integer range (the sieve's
 * `j += i`): every update then adds an exact integer in that range, so the
 * counter climbs from its start to at most the limit plus the largest
 * step. */
export function boundedIntegerLoopFacts(
  loop: IrStmt & { kind: "for" },
  locals: ReadonlyMap<string, IrLocal>,
  initial: ReadonlyMap<string, IntegerRange>,
): ReadonlyMap<string, IntegerRange> {
  const result = new Map<string, IntegerRange>();
  if (loop.init?.kind !== "varDecl" || loop.update?.kind !== "assign" || loop.cond?.kind !== "bin")
    return result;
  const counter = loop.init.localId,
    start = initial.get(counter);
  const constant = loop.update.localId === counter ? increment(counter, loop.update.value) : null;
  const variable =
    loop.update.localId === counter ? variableIncrement(counter, loop.update.value) : null;
  if (
    !start ||
    start.min < 0 ||
    (constant === null && variable === null) ||
    (constant !== null && (constant <= 0 || constant > 2147483647)) ||
    loop.cond.left.kind !== "varRef" ||
    loop.cond.left.localId !== counter ||
    (loop.cond.op !== "<" && loop.cond.op !== "<=")
  )
    return result;
  const written = new Set<string>(),
    refused = new Set<string>();
  const lower = new Map<string, number>(),
    upper = new Map<string, number>();
  let opaque = 0;
  const write = (id: string, delta: number | null): void => {
    written.add(id);
    if (opaque || delta === null) {
      refused.add(id);
      return;
    }
    const lo = (lower.get(id) ?? 0) + Math.min(0, delta);
    const hi = (upper.get(id) ?? 0) + Math.max(0, delta);
    if (!Number.isSafeInteger(lo) || !Number.isSafeInteger(hi)) refused.add(id);
    lower.set(id, lo);
    upper.set(id, hi);
  };
  const expr = (e: IrExpr): boolean => {
    if (e.kind === "assignExpr") write(e.localId, increment(e.localId, e.value));
    if (e.kind === "incDec") write(e.localId, e.op === "+" ? 1 : -1);
    return everyExprChild(e, expr, stmt);
  };
  const stmt = (s: IrStmt): boolean => {
    const region =
      s.kind === "for" ||
      s.kind === "while" ||
      s.kind === "doWhile" ||
      s.kind === "forOf" ||
      s.kind === "tryCatch" ||
      s.kind === "switch";
    if (region) opaque++;
    if (s.kind === "assign") write(s.localId, increment(s.localId, s.value));
    if (s.kind === "varDecl" || s.kind === "forOf") write(s.localId, null);
    const completed = everyStmtChild(s, expr, stmt);
    if (region) opaque--;
    return completed;
  };
  loop.body.every(stmt);
  if (written.has(counter)) return result;
  const stable = (id: string): boolean => {
    const local = locals.get(id);
    return local !== undefined && !local.boxed && !local.tdz && !written.has(id) && id !== counter;
  };
  function bound(e: IrExpr): IntegerRange | null {
    if (e.kind === "numLit" && Number.isSafeInteger(e.value) && !Object.is(e.value, -0))
      return { min: e.value, max: e.value };
    if (e.kind === "varRef" && stable(e.localId)) return initial.get(e.localId) ?? null;
    if (
      e.kind === "bytesIntrinsic" &&
      (e.method === "length" || e.method === "byteLength") &&
      e.receiver.kind === "varRef" &&
      stable(e.receiver.localId)
    )
      return { min: 0, max: Number.MAX_SAFE_INTEGER };
    return null;
  }
  let step: IntegerRange;
  if (constant !== null) step = { min: constant, max: constant };
  else {
    // The step binding is read on every update; it must keep one value.
    const operand = variable!.localId;
    const range = stable(operand) ? initial.get(operand) : undefined;
    if (!range) return result;
    step =
      variable!.sign > 0
        ? { min: range.min, max: range.max }
        : { min: -range.max, max: -range.min };
    if (step.min <= 0 || step.max > 2147483647) return result;
  }
  const limit = bound(loop.cond.right);
  if (!limit || limit.max < start.min) return result;
  const distance = limit.max - start.min;
  const iterations = Math.floor(distance / step.min) + 1;
  if (!Number.isSafeInteger(distance) || !Number.isSafeInteger(iterations)) return result;
  // Header facts also cover the failing final condition and zero iterations.
  const maximum = Math.max(start.max, limit.max + step.max);
  if (Number.isSafeInteger(maximum)) result.set(counter, { min: start.min, max: maximum });
  for (const [id, hi] of upper) {
    const range = initial.get(id);
    if (!range || refused.has(id) || id === counter) continue;
    const decrement = iterations * lower.get(id)!;
    const increment = iterations * hi;
    if (!Number.isSafeInteger(decrement) || !Number.isSafeInteger(increment)) continue;
    const min = range.min + decrement;
    const max = range.max + increment;
    if (Number.isSafeInteger(min) && Number.isSafeInteger(max)) result.set(id, { min, max });
  }
  return result;
}

/** Bound counters of a while loop by its condition. A counter qualifies when
 * the loop (condition and body) changes it only by increments of positive
 * integer literals outside nested loops, switch and exception regions, and a
 * conjunct of the condition compares it below a literal or a binding the loop
 * never writes (`while (x * x + y * y <= 4 && it < MAX) it++`). The body runs
 * only after that conjunct held, and the condition never writes the counter,
 * so every pass starts at most at the conjunct's bound and climbs by at most
 * the sum of the body's increments. The counter starts at its entry fact and
 * only grows, so the range holds at every read inside and after the loop. */
export function guardedLoopCounterFacts(
  loop: IrStmt & { kind: "while" },
  locals: ReadonlyMap<string, IrLocal>,
  initial: ReadonlyMap<string, IntegerRange>,
): ReadonlyMap<string, IntegerRange> {
  const result = new Map<string, IntegerRange>();
  const budget = new Map<string, number>(),
    refused = new Set<string>();
  let opaque = 0;
  const write = (id: string, delta: number | null): void => {
    if (opaque || delta === null || delta <= 0 || delta > 2147483647) refused.add(id);
    else budget.set(id, (budget.get(id) ?? 0) + delta);
  };
  const expr = (e: IrExpr): boolean => {
    if (e.kind === "assignExpr") write(e.localId, increment(e.localId, e.value));
    if (e.kind === "incDec") write(e.localId, e.op === "+" ? 1 : null);
    return everyExprChild(e, expr, stmt);
  };
  const stmt = (s: IrStmt): boolean => {
    const region =
      s.kind === "for" ||
      s.kind === "while" ||
      s.kind === "doWhile" ||
      s.kind === "forOf" ||
      s.kind === "tryCatch" ||
      s.kind === "switch";
    if (region) opaque++;
    if (s.kind === "assign") write(s.localId, increment(s.localId, s.value));
    if (s.kind === "varDecl" || s.kind === "forOf") write(s.localId, null);
    if (s.kind === "tryCatch" && s.catchLocalId) write(s.catchLocalId, null);
    const completed = everyStmtChild(s, expr, stmt);
    if (region) opaque--;
    return completed;
  };
  // The condition is evaluated before every pass; a write there would
  // separate the compared value from the one the body sees.
  const condition = new Set<string>();
  const conditionWrites = (e: IrExpr): boolean => {
    if (e.kind === "assignExpr" || e.kind === "incDec") condition.add(e.localId);
    return everyExprChild(e, conditionWrites, (s) => {
      opaque++;
      stmt(s);
      opaque--;
      return true;
    });
  };
  conditionWrites(loop.cond);
  for (const id of condition) refused.add(id);
  loop.body.every(stmt);
  const stable = (id: string): boolean => {
    const local = locals.get(id);
    return local !== undefined && !local.boxed && !local.tdz && !budget.has(id) && !refused.has(id);
  };
  const limit = (e: IrExpr): IntegerRange | null => {
    if (e.kind === "numLit" && Number.isSafeInteger(e.value) && !Object.is(e.value, -0))
      return { min: e.value, max: e.value };
    if (e.kind === "varRef" && stable(e.localId)) return initial.get(e.localId) ?? null;
    return null;
  };
  // Conjuncts that hold whenever the body runs.
  const conjuncts: IrExpr[] = [];
  const collect = (e: IrExpr): void => {
    if (e.kind === "toBool") collect(e.operand);
    else if (e.kind === "logical" && e.op === "&&") {
      collect(e.left);
      collect(e.right);
    } else conjuncts.push(e);
  };
  collect(loop.cond);
  const ceiling = new Map<string, number>();
  for (const c of conjuncts) {
    if (c.kind !== "bin") continue;
    // `counter < bound` or `bound > counter` (and the inclusive forms).
    const below = c.op === "<" || c.op === "<=",
      above = c.op === ">" || c.op === ">=";
    const counter = below ? c.left : above ? c.right : null,
      other = below ? c.right : c.left;
    if (counter?.kind !== "varRef") continue;
    const bound = limit(other);
    if (!bound) continue;
    const hi = c.op === "<" || c.op === ">" ? bound.max - 1 : bound.max;
    const previous = ceiling.get(counter.localId);
    ceiling.set(counter.localId, previous === undefined ? hi : Math.min(previous, hi));
  }
  for (const [id, step] of budget) {
    const local = locals.get(id),
      start = initial.get(id),
      hi = ceiling.get(id);
    if (refused.has(id) || !local || local.boxed || local.tdz || !start || hi === undefined)
      continue;
    const max = Math.max(start.max, hi + step);
    if (Number.isSafeInteger(start.min) && Number.isSafeInteger(max))
      result.set(id, { min: start.min, max });
  }
  return result;
}

/** Recognize only exits whose target cannot be inside this statement list.
 * Labeled blocks, loops, switch and exception regions retain the join. */
export function integerPathFallsThrough(body: readonly IrStmt[]): boolean {
  for (const stmt of body) {
    if (
      stmt.kind === "return" ||
      stmt.kind === "throw" ||
      stmt.kind === "rethrow" ||
      stmt.kind === "break" ||
      stmt.kind === "continue"
    )
      return false;
    if (stmt.kind === "block" && !stmt.labels?.length && !integerPathFallsThrough(stmt.body))
      return false;
    if (
      stmt.kind === "if" &&
      stmt.else_ &&
      !integerPathFallsThrough(stmt.then) &&
      !integerPathFallsThrough(stmt.else_)
    )
      return false;
  }
  return true;
}

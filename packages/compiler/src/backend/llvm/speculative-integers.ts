import type { IrExpr, IrStmt } from "../../ir/ir.js";
import { everyExprChild, everyStmtChild } from "../../ir/traverse.js";
import { f64Lit } from "./common.js";
import type { LlvmEmitterContext } from "./expr-context.js";
import { exactInteger, widenInteger } from "./integer-values.js";

/** Speculative integer loops.
 *
 * An innermost loop whose number locals are only written by statement-level
 * integer arithmetic (`x = x * 31 + n`, `x += y % m`, `x++`) runs as two
 * copies. The fast copy keeps those locals in i64 shadow slots holding safe
 * integers and computes the writes with checked integer arithmetic; every
 * write also stores the exact double, so the ordinary slot is always current
 * and loop exits, calls and jumps need no write-back. A check that fails
 * (overflow past 2^53 - 1, a result of -0, a fractional or non-finite leaf, a
 * zero divisor) branches to the same statement in the ordinary double copy,
 * which re-executes it and finishes the loop there. Re-execution is exact
 * because a speculated statement evaluates nothing but locals, literals and
 * arithmetic before it writes.
 *
 * The loop is entered through the fast copy only when every speculated local
 * that is live on entry already holds a safe integer other than -0. */
export interface SpeculativeLoopPlan {
  /** Speculated locals; `true` when the entry value is live and checked. */
  locals: Map<string, boolean>;
  /** Statement-level writes computed as integers in the fast copy. */
  writes: Set<IrStmt>;
}

type SpeculativeLoop = Extract<IrStmt, { kind: "for" | "while" | "doWhile" }>;

/** The fast copy duplicates the loop; keep the duplicated code small. */
const MAX_LOOP_NODES = 400;

/** Statements whose emission is plain control flow or a single write.
 * Nested loops, switches and try statements keep the loop on the ordinary
 * path (their emission keeps state that the two copies would not share). */
const SIMPLE_STATEMENTS = new Set<string>([
  "varDecl",
  "assign",
  "exprStmt",
  "if",
  "block",
  "arraySet",
  "bytesSet",
  "fieldSet",
  "recordSet",
  "break",
  "continue",
  "return",
]);

const INTEGER_OPS = new Set<string>(["+", "-", "*", "%", "&", "|", "^", "<<", ">>", ">>>"]);
const ARITHMETIC_OPS = new Set<string>(["+", "-", "*", "%"]);

/** A number expression that reads only locals and literals through integer
 * operators: evaluating it has no effects, so a failed check may restart its
 * statement. Division and exponentiation usually leave the integers and
 * would only bail. */
export function isSpeculableValue(e: IrExpr): boolean {
  if (e.type.kind !== "f64") return false;
  switch (e.kind) {
    case "numLit":
      return Number.isSafeInteger(e.value) && !Object.is(e.value, -0);
    case "varRef":
      return true;
    case "bin":
      return INTEGER_OPS.has(e.op) && isSpeculableValue(e.left) && isSpeculableValue(e.right);
    case "unary":
      return (e.op === "-" || e.op === "~") && isSpeculableValue(e.operand);
    default:
      return false;
  }
}

function hasArithmetic(e: IrExpr): boolean {
  if (e.kind === "bin")
    return ARITHMETIC_OPS.has(e.op) || hasArithmetic(e.left) || hasArithmetic(e.right);
  if (e.kind === "unary") return e.op === "-" || hasArithmetic(e.operand);
  return false;
}

/** The written local and value of a statement-level write, or null. A
 * value of null with a local means `x++`/`x--`. */
export function speculativeWriteTarget(
  s: IrStmt,
): { localId: string; value: IrExpr | null; op: "+" | "-" } | null {
  switch (s.kind) {
    case "assign":
      return { localId: s.localId, value: s.value, op: "+" };
    case "varDecl":
      return s.init ? { localId: s.localId, value: s.init, op: "+" } : null;
    case "exprStmt":
      if (s.expr.kind === "incDec") return { localId: s.expr.localId, value: null, op: s.expr.op };
      if (s.expr.kind === "assignExpr")
        return { localId: s.expr.localId, value: s.expr.value, op: "+" };
      return null;
    default:
      return null;
  }
}

export function planSpeculativeLoop(
  loop: SpeculativeLoop,
  eligible: (localId: string) => boolean,
): SpeculativeLoopPlan | null {
  const writes = new Map<string, IrStmt[]>();
  const unspeculable = new Set<string>();
  const reads = new Set<string>();
  const declared = new Set<string>();
  let nodes = 0;
  let rejected = false;
  let arithmetic = false;

  const expr = (e: IrExpr): boolean => {
    if (rejected) return false;
    nodes++;
    if (e.kind === "varRef") reads.add(e.localId);
    else if (e.kind === "assignExpr" || e.kind === "incDec") unspeculable.add(e.localId);
    return everyExprChild(e, expr, stmt);
  };
  const stmt = (s: IrStmt): boolean => {
    if (rejected) return false;
    nodes++;
    if (!SIMPLE_STATEMENTS.has(s.kind)) {
      rejected = true;
      return false;
    }
    if (s.kind === "varDecl") declared.add(s.localId);
    const target = speculativeWriteTarget(s);
    if (target) {
      if (target.value === null || isSpeculableValue(target.value)) {
        const list = writes.get(target.localId) ?? [];
        list.push(s);
        writes.set(target.localId, list);
        if (target.value === null) reads.add(target.localId);
        else expr(target.value);
        return !rejected;
      }
      unspeculable.add(target.localId);
      if (target.value) expr(target.value);
      return !rejected;
    }
    return everyStmtChild(s, expr, stmt);
  };

  if (loop.cond) expr(loop.cond);
  if (loop.kind === "for" && loop.update) stmt(loop.update);
  for (const s of loop.body) stmt(s);
  if (rejected || nodes > MAX_LOOP_NODES) return null;

  const locals = new Map<string, boolean>();
  const speculated = new Set<IrStmt>();
  for (const [id, list] of writes) {
    if (unspeculable.has(id) || !reads.has(id) || !eligible(id)) continue;
    locals.set(id, !declared.has(id));
    for (const s of list) speculated.add(s);
  }
  if (speculated.size === 0) return null;
  // Loop-invariant integer inputs of the writes and the condition join the
  // shadows, so their reads carry integer facts too.
  const invariant = (e: IrExpr): boolean => {
    if (e.kind === "varRef") {
      const id = e.localId;
      if (!locals.has(id) && !writes.has(id) && !unspeculable.has(id) && eligible(id))
        locals.set(id, true);
      return true;
    }
    return everyExprChild(e, invariant, () => true);
  };
  for (const s of speculated) {
    const target = speculativeWriteTarget(s)!;
    if (target.value === null) arithmetic = true;
    else {
      if (hasArithmetic(target.value)) arithmetic = true;
      invariant(target.value);
    }
  }
  if (!arithmetic) return null;
  if (loop.cond) invariant(loop.cond);
  return { locals, writes: speculated };
}

const SAFE = Number.MAX_SAFE_INTEGER;

/** The range every speculative shadow holds. */
export const SPECULATIVE_RANGE = { min: -SAFE, max: SAFE };

/** Convert a double to i64 and test that it is a safe integer other than
 * -0: the ordered range tests reject NaN and infinities, and the bit
 * patterns of the value and its round trip agree only for integers that are
 * not -0. `freeze` keeps out-of-range conversions from producing poison. */
export function emitSafeIntegerCheck(host: LlvmEmitterContext, value: string): [string, string] {
  const B = host.B;
  const low = B.tmp(),
    high = B.tmp(),
    inRange = B.tmp(),
    raw = B.tmp(),
    integer = B.tmp(),
    back = B.tmp(),
    bits = B.tmp(),
    backBits = B.tmp(),
    exact = B.tmp(),
    ok = B.tmp();
  B.line(`${low} = fcmp oge double ${value}, ${f64Lit(-SAFE)}`);
  B.line(`${high} = fcmp ole double ${value}, ${f64Lit(SAFE)}`);
  B.line(`${inRange} = and i1 ${low}, ${high}`);
  B.line(`${raw} = fptosi double ${value} to i64`);
  B.line(`${integer} = freeze i64 ${raw}`);
  B.line(`${back} = sitofp i64 ${integer} to double`);
  B.line(`${bits} = bitcast double ${value} to i64`);
  B.line(`${backBits} = bitcast double ${back} to i64`);
  B.line(`${exact} = icmp eq i64 ${bits}, ${backBits}`);
  B.line(`${ok} = and i1 ${inRange}, ${exact}`);
  return [integer, ok];
}

/** A condition that is true when an i64 lies outside the safe range. */
function unsafeInteger(host: LlvmEmitterContext, value: string): string {
  const B = host.B;
  const biased = B.tmp(),
    outside = B.tmp();
  B.line(`${biased} = add i64 ${value}, ${SAFE}`);
  B.line(`${outside} = icmp ugt i64 ${biased}, ${2 * SAFE}`);
  return outside;
}

function either(host: LlvmEmitterContext, a: string, b: string): string {
  const t = host.B.tmp();
  host.B.line(`${t} = or i1 ${a}, ${b}`);
  return t;
}

/** Evaluate a speculable value (isSpeculableValue) as a safe i64. `bail`
 * branches away when its condition holds, so the integer result equals the
 * JS number exactly whenever control continues: sums and products stay
 * within 2^53 - 1, no result is -0, and `%` never divides by zero. Other
 * operators evaluate through the ordinary emitter and must yield a safe
 * integer. */
export function emitSpeculativeInteger(
  host: LlvmEmitterContext,
  e: IrExpr,
  bail: (condition: string) => void,
): string {
  const B = host.B;
  switch (e.kind) {
    case "numLit":
      return String(e.value);
    case "varRef": {
      const slot = host.integerLoopBindings.get(e.localId);
      if (slot !== undefined) {
        const value = B.tmp();
        B.line(`${value} = load ${slot.type}, ptr ${slot.slot}`);
        if (slot.type === "i64") return value;
        const wide = B.tmp();
        B.line(`${wide} = ${slot.signed ? "sext" : "zext"} i32 ${value} to i64`);
        return wide;
      }
      const int32 = host.int32Locals.get(e.localId);
      if (int32 !== undefined) {
        const bits = B.tmp(),
          wide = B.tmp();
        B.line(`${bits} = load i32, ptr ${host.binding(e.localId).slot}`);
        B.line(`${wide} = ${int32.signed ? "sext" : "zext"} i32 ${bits} to i64`);
        return wide;
      }
      break;
    }
    case "bin": {
      if (e.op !== "+" && e.op !== "-" && e.op !== "*" && e.op !== "%") break;
      const a = emitSpeculativeInteger(host, e.left, bail);
      const b = emitSpeculativeInteger(host, e.right, bail);
      const result = B.tmp();
      if (e.op === "+" || e.op === "-") {
        // Safe operands cannot overflow i64; an exact zero sum is +0.
        B.line(`${result} = ${e.op === "+" ? "add" : "sub"} nsw i64 ${a}, ${b}`);
        bail(unsafeInteger(host, result));
        return result;
      }
      if (e.op === "*") {
        host.declare("declare { i64, i1 } @llvm.smul.with.overflow.i64(i64, i64)");
        const pair = B.tmp(),
          overflow = B.tmp(),
          zero = B.tmp(),
          signs = B.tmp(),
          negative = B.tmp(),
          negativeZero = B.tmp();
        B.line(`${pair} = call { i64, i1 } @llvm.smul.with.overflow.i64(i64 ${a}, i64 ${b})`);
        B.line(`${result} = extractvalue { i64, i1 } ${pair}, 0`);
        B.line(`${overflow} = extractvalue { i64, i1 } ${pair}, 1`);
        // A zero product with a negative factor is -0.
        B.line(`${zero} = icmp eq i64 ${result}, 0`);
        B.line(`${signs} = or i64 ${a}, ${b}`);
        B.line(`${negative} = icmp slt i64 ${signs}, 0`);
        B.line(`${negativeZero} = and i1 ${zero}, ${negative}`);
        bail(either(host, either(host, overflow, unsafeInteger(host, result)), negativeZero));
        return result;
      }
      // `%`: a zero divisor yields NaN, and a zero remainder of a negative
      // dividend is -0. Safe operands cannot hit INT64_MIN % -1.
      const zeroDivisor = B.tmp();
      B.line(`${zeroDivisor} = icmp eq i64 ${b}, 0`);
      bail(zeroDivisor);
      const zero = B.tmp(),
        negative = B.tmp(),
        negativeZero = B.tmp();
      B.line(`${result} = srem i64 ${a}, ${b}`);
      B.line(`${zero} = icmp eq i64 ${result}, 0`);
      B.line(`${negative} = icmp slt i64 ${a}, 0`);
      B.line(`${negativeZero} = and i1 ${zero}, ${negative}`);
      bail(negativeZero);
      return result;
    }
    case "unary": {
      if (e.op !== "-") break;
      const a = emitSpeculativeInteger(host, e.operand, bail);
      const zero = B.tmp(),
        result = B.tmp();
      // -0 is not an integer result.
      B.line(`${zero} = icmp eq i64 ${a}, 0`);
      bail(zero);
      B.line(`${result} = sub nsw i64 0, ${a}`);
      return result;
    }
    default:
      break;
  }
  const value = host.emitExpr(e);
  const integer = exactInteger(host, value, e);
  if (integer && integer.range.min >= -SAFE && integer.range.max <= SAFE)
    return widenInteger(host, integer);
  const [wide, ok] = emitSafeIntegerCheck(host, value.name);
  const fail = B.tmp();
  B.line(`${fail} = xor i1 ${ok}, true`);
  bail(fail);
  return wide;
}

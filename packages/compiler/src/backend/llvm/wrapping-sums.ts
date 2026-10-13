import type { IrExpr } from "../../ir/ir.js";
import { integerArithmeticRange, type IntegerRange } from "../../ir/integer-ranges.js";
import type { LlValue, LlvmEmitterContext } from "./expr-context.js";
import type { LlInteger } from "./integer-values.js";

/** Marks the `+` and `-` operands whose number only reaches ToInt32/ToUint32
 * consumers (`| 0`, the other bitwise operators, `Math.imul`, `Math.clz32`),
 * directly or through further sums, in the emitter's `wrappingSums`. Called
 * by the consumer before its operands emit. */
export function markWrappingOperands(host: LlvmEmitterContext, ...operands: IrExpr[]): void {
  for (const operand of operands) {
    if (operand.kind !== "bin" || (operand.op !== "+" && operand.op !== "-")) continue;
    if (operand.type.kind !== "f64" || host.wrappingSums.has(operand)) continue;
    host.wrappingSums.add(operand);
    markWrappingOperands(host, operand.left, operand.right);
  }
}

/** The values an f64 expression can have when each one is an exact integer
 * (never -0) or NaN: proven ranges, safe integer literals, NaN-coded reads
 * of integer typed-array elements, `charCodeAt`, and sums and differences of those whose
 * every integer result is still exact in a double. */
function integerOrNaNRange(host: LlvmEmitterContext, e: IrExpr): IntegerRange | null {
  if (e.type.kind !== "f64") return null;
  const range = host.integerRanges.get(e);
  if (range) return range;
  if (e.kind === "numLit")
    return Number.isSafeInteger(e.value) && !Object.is(e.value, -0)
      ? { min: e.value, max: e.value }
      : null;
  if (
    e.kind === "bytesIntrinsic" &&
    e.method === "get" &&
    e.invalidNaN === true &&
    e.receiver.type.kind === "bytes"
  )
    return ELEMENT_RANGES[e.receiver.type.elem] ?? null;
  // A UTF-16 code unit, or NaN past either end.
  if (e.kind === "strIntrinsic" && e.method === "charCodeAt") return { min: 0, max: 65535 };
  if (e.kind === "bin" && (e.op === "+" || e.op === "-")) {
    const left = integerOrNaNRange(host, e.left);
    const right = left && integerOrNaNRange(host, e.right);
    return right ? integerArithmeticRange(e.op, left!, right) : null;
  }
  return null;
}

const ELEMENT_RANGES: Partial<Record<string, IntegerRange>> = {
  u8: { min: 0, max: 255 },
  u8c: { min: 0, max: 255 },
  i8: { min: -128, max: 127 },
  u16: { min: 0, max: 65535 },
  i16: { min: -32768, max: 32767 },
  u32: { min: 0, max: 4294967295 },
  i32: { min: -2147483648, max: 2147483647 },
};

/** The low 32 bits of an operand (0 for NaN), and an i1 that is false when
 * it is NaN (null when it never is). */
function wrappingOperand(
  host: LlvmEmitterContext,
  value: LlValue,
  integer: LlInteger | null,
  range: IntegerRange,
): { low: string; valid: string | null } {
  const B = host.B;
  if (integer) {
    if (integer.type === "i32") return { low: integer.name, valid: null };
    const low = B.tmp();
    B.line(`${low} = trunc i64 ${integer.name} to i32`);
    return { low, valid: null };
  }
  // The number is an exact integer or NaN, and its ToUint32 view is the
  // integer's low 32 bits or 0. An ordered compare tells the two apart.
  const valid = B.tmp();
  B.line(`${valid} = fcmp ord double ${value.name}, 0.0`);
  if (value.uint32 !== undefined) return { low: value.uint32, valid };
  // Without a view, convert once. The conversion of NaN is poison, but the
  // result only selects the sum when every operand is ordered.
  const low = B.tmp();
  if (range.min >= -2147483648 && range.max <= 2147483647) {
    B.line(`${low} = fptosi double ${value.name} to i32`);
  } else {
    const wide = B.tmp();
    B.line(`${wide} = fptosi double ${value.name} to i64`);
    B.line(`${low} = trunc i64 ${wide} to i32`);
  }
  return { low, valid };
}

/** ToUint32 of `left op right` (`+` or `-`) in 32-bit arithmetic when the
 * expression only reaches ToInt32/ToUint32 consumers and both operands are
 * exact integers or NaN with an exact result. Both conversions are
 * arithmetic mod 2^32, so the wrapping i32 sum of the operands' low halves
 * is the converted exact sum; a NaN operand makes the sum NaN, which
 * converts to 0. Returns undefined, emitting nothing, for any other sum. */
export function emitWrappingSum(
  host: LlvmEmitterContext,
  e: IrExpr & { kind: "bin" },
  l: LlValue,
  r: LlValue,
  li: LlInteger | null,
  ri: LlInteger | null,
): string | undefined {
  if ((e.op !== "+" && e.op !== "-") || !host.wrappingSums.has(e)) return undefined;
  const leftRange = li ? li.range : integerOrNaNRange(host, e.left);
  const rightRange = leftRange && (ri ? ri.range : integerOrNaNRange(host, e.right));
  if (!rightRange || !integerArithmeticRange(e.op, leftRange!, rightRange)) return undefined;
  const B = host.B;
  const left = wrappingOperand(host, l, li, leftRange!);
  const right = wrappingOperand(host, r, ri, rightRange);
  const sum = B.tmp();
  B.line(`${sum} = ${e.op === "+" ? "add" : "sub"} i32 ${left.low}, ${right.low}`);
  let valid = left.valid ?? right.valid;
  if (valid === null) return sum;
  if (left.valid && right.valid) {
    valid = B.tmp();
    B.line(`${valid} = and i1 ${left.valid}, ${right.valid}`);
  }
  const out = B.tmp();
  B.line(`${out} = select i1 ${valid}, i32 ${sum}, i32 0`);
  return out;
}

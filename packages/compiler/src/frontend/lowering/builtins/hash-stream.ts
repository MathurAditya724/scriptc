import * as ts from "../../ts7/adapter.js";
import { type Lowerer } from "../lowerer.js";
import { locOf } from "../../program.js";
import { varRef } from "../../../ir/build.js";
import { type IrExpr, type IrType } from "../../../ir/ir.js";
import { EMITTER_API_MEMBERS } from "../lower-classes.js";
import { lowerEmitterMethodCall } from "../lower-event-emitter.js";
import { STREAM_API_MEMBERS, STREAM_OPERATORS, lowerStreamMethodCall } from "../lower-stream.js";

/* node:crypto's Hash and Hmac are Transforms: a value written, read,
 * listened to, or piped as a stream reads and writes through its own
 * native Transform (scr_stream.c), created on first use. update() and
 * digest() keep the value's static lowering; the stream members lower
 * through the stream and emitter spokes over that Transform. */

const TRANSFORM_CLASS = "%Transform";
const TRANSFORM: IrType = { kind: "object", className: TRANSFORM_CLASS };

export function isHashValueType(type: IrType | null | undefined): boolean {
  return type?.kind === "cryptoHash" || type?.kind === "cryptoHmac";
}

/** The Transform of a lowered Hash or Hmac value (+1). A pipe
 * destination or pipeline stage (`piped`) also keeps the value alive
 * until its stream flushes or is destroyed. */
export function hashStreamOf(value: IrExpr, piped = false): IrExpr {
  return {
    kind: "libCall",
    fn: piped ? "crypto.hashStreamPiped" : "crypto.hashStream",
    args: [value],
    type: TRANSFORM,
    loc: value.loc,
  };
}

/** A stream member called on a Hash or Hmac (`hash.write(chunk)`,
 * `hash.on("data", cb)`, `hash.setEncoding("hex")`). Members that answer
 * the stream (`this`) answer the Hash itself. */
export function lowerHashStreamCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (call.questionDotToken || access.questionDotToken) return null;
  const name = access.name.text;
  const streamMember = STREAM_API_MEMBERS.has(name) || STREAM_OPERATORS.has(name);
  if (!streamMember && !EMITTER_API_MEMBERS.has(name)) return null;
  if (!isHashValueType(lowerer.mapTypeOf(lowerer.typeOf(access.expression)))) return null;
  const info = lowerer.classes.get(TRANSFORM_CLASS);
  if (!info) return null;
  const loc = locOf(call);
  const hash = lowerer.lowerExpr(access.expression);
  const local = lowerer.declareHiddenLocal("%hash", hash.type);
  // The spokes lower the receiver to the value's Transform.
  lowerer.hashStreamReceivers.set(access.expression, { localId: local.id, type: hash.type });
  let lowered: IrExpr | null;
  try {
    lowered = streamMember
      ? lowerStreamMethodCall(lowerer, call, access, info)
      : lowerEmitterMethodCall(lowerer, call, access, info);
  } finally {
    lowerer.hashStreamReceivers.delete(access.expression);
  }
  if (!lowered) return null;
  const answersStream =
    lowered.type.kind === "object" && lowered.type.className === TRANSFORM_CLASS;
  const result: IrExpr = answersStream
    ? {
        kind: "seqExpr",
        stmts: [{ kind: "exprStmt", expr: lowered, loc }],
        result: varRef(local.id, hash.type, loc),
        type: hash.type,
        loc,
      }
    : lowered;
  return {
    kind: "seqExpr",
    stmts: [{ kind: "varDecl", localId: local.id, init: hash, loc }],
    result,
    type: result.type,
    loc,
  };
}

import { lowerBuiltinByteInput, errorFirstBytesCallback } from "./arguments.js";
import { numLit } from "../../../ir/build.js";
import { InternalCompilerError } from "../../../errors.js";
import * as ts from "../../ts7/adapter.js";
import { type Lowerer } from "../lowerer.js";
import { BYTES_U8, F64, type IrExpr, type IrLibFn, type SrcLoc, VOID } from "../../../ir/ir.js";

const ZLIB_SYNC_FNS: Readonly<Record<string, IrLibFn | undefined>> = {
  deflateSync: "zlib.deflateSync",
  inflateSync: "zlib.inflateSync",
  deflateRawSync: "zlib.deflateRawSync",
  inflateRawSync: "zlib.inflateRawSync",
  gzipSync: "zlib.gzipSync",
  gunzipSync: "zlib.gunzipSync",
  unzipSync: "zlib.unzipSync",
};

const ZLIB_CALLBACK_FNS: Readonly<Record<string, IrLibFn | undefined>> = {
  deflate: "zlib.deflateCb",
  inflate: "zlib.inflateCb",
  deflateRaw: "zlib.deflateRawCb",
  inflateRaw: "zlib.inflateRawCb",
  gzip: "zlib.gzipCb",
  gunzip: "zlib.gunzipCb",
  unzip: "zlib.unzipCb",
};

export function lowerZlibModuleCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  bi: { module: string; member: string },
  loc: SrcLoc,
): IrExpr {
  if (expr.arguments.some(ts.isSpreadElement)) {
    lowerer.noLowering(`zlib.${bi.member} with spread arguments`, expr);
  }
  const syncFn = ZLIB_SYNC_FNS[bi.member];
  if (syncFn !== undefined) {
    if (
      expr.arguments.length === 2 &&
      (bi.member === "deflateSync" || bi.member === "deflateRawSync" || bi.member === "gzipSync")
    ) {
      const options = expr.arguments[1]!;
      // A literal level is enough for build-time compression in the native
      // emitters. Other options retain the explicit refusal: dropping
      // strategy/windowBits/dictionaries without a diagnostic changes the
      // wire bytes.
      if (ts.isObjectLiteralExpression(options) && options.properties.length === 1) {
        const prop = options.properties[0]!;
        if (
          ts.isPropertyAssignment(prop) &&
          (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) &&
          prop.name.text === "level"
        ) {
          const value = prop.initializer;
          const level = ts.isNumericLiteral(value)
            ? Number(value.text)
            : ts.isPrefixUnaryExpression(value) &&
                value.operator === ts.SyntaxKind.MinusToken &&
                ts.isNumericLiteral(value.operand)
              ? -Number(value.operand.text)
              : NaN;
          if (Number.isInteger(level) && level >= -1 && level <= 9) {
            return {
              kind: "libCall",
              fn: "zlib.deflateLevelSync",
              args: [
                lowerBuiltinByteInput(lowerer, expr.arguments[0]!, loc, "zlib"),
                numLit(
                  bi.member === "deflateSync" ? 0 : bi.member === "deflateRawSync" ? 1 : 2,
                  loc,
                ),
                numLit(level, loc),
              ],
              type: BYTES_U8,
              loc,
            };
          }
        }
      }
      lowerer.noLowering(
        `${bi.member} with these options`,
        options,
        "the static compression options form is { level: <integer literal from -1 through 9> }",
      );
    }
    if (expr.arguments.length !== 1) {
      const site = expr.arguments[1] ?? expr;
      lowerer.noLowering(
        `${bi.member} with explicit options`,
        site,
        `${bi.member}(data) with Node's default options is supported`,
      );
    }
    return {
      kind: "libCall",
      fn: syncFn,
      args: [lowerBuiltinByteInput(lowerer, expr.arguments[0]!, loc, "zlib")],
      type: BYTES_U8,
      loc,
    };
  }
  const callbackFn = ZLIB_CALLBACK_FNS[bi.member];
  if (callbackFn !== undefined) {
    if (expr.arguments.length !== 2) {
      const site = expr.arguments.length >= 3 ? expr.arguments[1]! : expr;
      lowerer.noLowering(
        `${bi.member} with ${expr.arguments.length} arguments`,
        site,
        `${bi.member}(data, callback) with Node's default options is supported; explicit options are not yet lowered`,
      );
    }
    return {
      kind: "libCall",
      fn: callbackFn,
      args: [
        lowerBuiltinByteInput(lowerer, expr.arguments[0]!, loc, "zlib"),
        errorFirstBytesCallback(lowerer, expr.arguments[1]!, "zlib"),
      ],
      type: VOID,
      loc,
    };
  }
  if (bi.member === "crc32") {
    if (expr.arguments.length < 1 || expr.arguments.length > 2) {
      lowerer.noLowering(
        `zlib.crc32 with ${expr.arguments.length} arguments`,
        expr,
        "crc32(data[, initialValue]) is supported",
      );
    }
    return {
      kind: "libCall",
      fn: "zlib.crc32",
      args: [
        lowerBuiltinByteInput(lowerer, expr.arguments[0]!, loc, "zlib"),
        expr.arguments[1]
          ? lowerer.lowerExprExpecting(expr.arguments[1]!, F64)
          : { kind: "numLit", value: 0, type: F64, loc },
      ],
      type: F64,
      loc,
    };
  }
  throw new InternalCompilerError(`unhandled lowered zlib member ${bi.member}`);
}

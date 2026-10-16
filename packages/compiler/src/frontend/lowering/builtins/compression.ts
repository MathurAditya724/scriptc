import { lowerBuiltinByteInput, errorFirstBytesCallback } from "./arguments.js";
import { dynUndefinedExpr, numLit } from "../../../ir/build.js";
import { InternalCompilerError } from "../../../errors.js";
import * as ts from "../../ts7/adapter.js";
import { type Lowerer } from "../lowerer.js";
import { locOf } from "../../program.js";
import { isNodeTypesPath } from "../../dts-paths.js";
import {
  BYTES_U8,
  DYN,
  F64,
  funcOf,
  type IrExpr,
  type IrLibFn,
  type IrType,
  type SrcLoc,
  VOID,
  ZLIB_STREAM_MODES,
} from "../../../ir/ir.js";

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

const ZLIB_STREAM_T: IrType = { kind: "object", className: "%Transform" };

/** `zlib.createGzip(options?)` and `new zlib.Gzip(options?)`: the runtime
 * Transform stream (scr_zlib_stream.c). The options value crosses as a dyn
 * value and is validated at runtime with Node's ladder, so literal and
 * computed options take the same path. */
export function lowerZlibStreamNew(
  lowerer: Lowerer,
  args: readonly ts.Expression[],
  mode: number,
  what: string,
  site: ts.Node,
  loc: SrcLoc,
): IrExpr {
  if (args.some(ts.isSpreadElement)) lowerer.noLowering(`${what} with spread arguments`, site);
  if (args.length > 1) {
    lowerer.noLowering(
      `${what} with ${args.length} arguments`,
      args[1]!,
      "the supported form takes one options object",
    );
  }
  let options: IrExpr = dynUndefinedExpr(loc);
  if (args[0] !== undefined) {
    const raw = lowerer.lowerExpr(args[0]);
    if (raw.type.kind === "dyn") options = raw;
    else if (raw.kind === "unitLit" || lowerer.dynConvertible(raw.type)) {
      options = { kind: "dynFrom", value: raw, type: DYN, loc };
    } else {
      lowerer.noLowering(
        `${what} with a '${lowerer.fmt(raw.type)}' options value`,
        args[0],
        "zlib stream options are a plain object of numbers, booleans and Buffers",
      );
    }
  }
  return {
    kind: "libCall",
    fn: "zlib.streamNew",
    args: [numLit(mode, loc), options],
    type: ZLIB_STREAM_T,
    loc,
  };
}

/** The node_zlib_mode of a zlib stream CLASS symbol (`new zlib.Gzip()`,
 * `new Gzip()` through any import spelling) declared by the shipped
 * fallback, or null. */
export function zlibStreamModeOf(
  lowerer: Lowerer,
  symbol: ts.Symbol | null | undefined,
): number | null {
  if (!symbol) return null;
  const target =
    symbol.flags & ts.SymbolFlags.Alias ? lowerer.checker.getAliasedSymbol(symbol) : symbol;
  const mode = ZLIB_STREAM_MODES.get(target.name);
  if (mode === undefined) return null;
  return lowerer.checker
    .declarationsOf(target)
    .some((d) => ts.isClassDeclaration(d) && isZlibFallbackDecl(lowerer, d))
    ? mode
    : null;
}

function isZlibFallbackDecl(lowerer: Lowerer, d: ts.Node): boolean {
  const file = d.getSourceFile();
  if (!lowerer.isStdlibFile(file) || isNodeTypesPath(file.fileName)) return false;
  for (let node: ts.Node | undefined = d.parent; node; node = node.parent) {
    if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)) {
      return node.name.text === "zlib" || node.name.text === "node:zlib";
    }
  }
  return false;
}

/** True when `access` names a member the zlib stream base class declares
 * (bytesWritten, flush, params, close, reset). */
export function isZlibStreamMember(lowerer: Lowerer, access: ts.PropertyAccessExpression): boolean {
  const symbol = lowerer.checker.getSymbolAtLocation(access.name);
  if (!symbol) return false;
  return lowerer.checker
    .declarationsOf(symbol)
    .some(
      (d) =>
        d.parent !== undefined &&
        ts.isClassDeclaration(d.parent) &&
        d.parent.name?.text === "ZlibBase" &&
        isZlibFallbackDecl(lowerer, d.parent),
    );
}

/** `stream.bytesWritten` on a zlib stream. */
export function lowerZlibStreamBytesWritten(
  lowerer: Lowerer,
  access: ts.PropertyAccessExpression,
): IrExpr {
  const loc = locOf(access);
  return {
    kind: "libCall",
    fn: "zlib.streamBytesWritten",
    args: [lowerer.lowerExpr(access.expression)],
    type: F64,
    loc,
  };
}

/** flush/params/close/reset on a zlib stream. Callbacks are () => void,
 * the write-callback rule; numeric operands cross as dyn values for the
 * runtime's range checks. */
export function lowerZlibStreamMethodCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr {
  const loc = locOf(call);
  const member = access.name.text;
  const args = call.arguments;
  if (args.some(ts.isSpreadElement)) lowerer.noLowering(`${member} with spread arguments`, call);
  const isFunc = (node: ts.Expression): boolean =>
    lowerer.mapTypeOf(lowerer.typeOf(node))?.kind === "func";
  const callback = (node: ts.Expression): IrExpr => {
    const cb = lowerer.lowerExprExpecting(node, funcOf([], VOID));
    if (cb.type.kind !== "func" || cb.type.params.length > 0) {
      lowerer.noLowering(
        `zlib ${member} callbacks taking arguments`,
        node,
        "() => void callbacks are supported (listen for 'error' to observe failures)",
      );
    }
    return cb;
  };
  const value = (node: ts.Expression | undefined): IrExpr => {
    if (node === undefined) return dynUndefinedExpr(loc);
    const raw = lowerer.lowerExpr(node);
    if (raw.type.kind === "dyn") return raw;
    if (raw.kind === "unitLit" || lowerer.dynConvertible(raw.type)) {
      return { kind: "dynFrom", value: raw, type: DYN, loc };
    }
    lowerer.noLowering(`zlib ${member} with a '${lowerer.fmt(raw.type)}' argument`, node);
  };
  const receiver = (): IrExpr => lowerer.lowerExpr(access.expression);
  const call0 = (fn: IrLibFn, operands: IrExpr[]): IrExpr => ({
    kind: "libCall",
    fn,
    args: operands,
    type: VOID,
    loc,
  });
  const tooMany = (max: number): void => {
    if (args.length > max) lowerer.noLowering(`zlib ${member} with ${args.length} arguments`, call);
  };
  switch (member) {
    case "flush": {
      tooMany(2);
      // flush(cb) moves a function first argument into the callback slot.
      const first = args[0];
      const cbNode = first !== undefined && isFunc(first) ? first : args[1];
      const kindNode = first !== undefined && first !== cbNode ? first : undefined;
      const recv = receiver();
      const kind = value(kindNode);
      return cbNode !== undefined
        ? call0("zlib.streamFlushCb", [recv, kind, callback(cbNode)])
        : call0("zlib.streamFlush", [recv, kind]);
    }
    case "params": {
      tooMany(3);
      const recv = receiver();
      const level = value(args[0]);
      const strategy = value(args[1]);
      return args[2] !== undefined
        ? call0("zlib.streamParamsCb", [recv, level, strategy, callback(args[2])])
        : call0("zlib.streamParams", [recv, level, strategy]);
    }
    case "close": {
      tooMany(1);
      const recv = receiver();
      return args[0] !== undefined
        ? call0("zlib.streamCloseCb", [recv, callback(args[0])])
        : call0("zlib.streamClose", [recv]);
    }
    case "reset":
      tooMany(0);
      return call0("zlib.streamReset", [receiver()]);
    default:
      lowerer.noLowering(`zlib stream member '${member}'`, access);
  }
}

const ZLIB_STREAM_FACTORIES: Readonly<Record<string, number | undefined>> = {
  createDeflate: 1,
  createInflate: 2,
  createGzip: 3,
  createGunzip: 4,
  createDeflateRaw: 5,
  createInflateRaw: 6,
  createUnzip: 7,
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
  const streamMode = ZLIB_STREAM_FACTORIES[bi.member];
  if (streamMode !== undefined) {
    return lowerZlibStreamNew(lowerer, expr.arguments, streamMode, `zlib.${bi.member}`, expr, loc);
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

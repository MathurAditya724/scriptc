import { boolLit, strLit } from "../../../ir/build.js";
import * as ts from "../../ts7/adapter.js";
import { type Lowerer } from "../lowerer.js";
import { isJsSourceFile, locOf } from "../../program.js";
import { isChildSurfaceMember } from "../surfaces.js";
import { bufEncoding } from "../containers/bytes.js";
import {
  BOOL,
  CHILDSTREAM_T,
  CHILDWRITER_T,
  DYN,
  type IrExpr,
  type IrType,
  STRING,
  VOID,
  canBoxFuncIntoDyn,
} from "../../../ir/ir.js";
import {
  ipcJsonMessage,
  ipcSendCallback,
  ipcMessageListener,
  ipcDisconnectListener,
} from "./ipc.js";
import { stripTypeCasts } from "./arguments.js";

export function lowerChildMethodCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (call.questionDotToken || access.questionDotToken) return null;
  if (lowerer.mapTypeOf(lowerer.typeOf(access.expression))?.kind !== "child") return null;
  if (!isChildSurfaceMember(lowerer, access)) return null;
  const name = access.name.text;
  const loc = locOf(call);
  if (name === "send") {
    if (
      call.arguments.length < 1 ||
      call.arguments.length > 2 ||
      call.arguments.some(ts.isSpreadElement)
    ) {
      lowerer.noLowering(
        `child.send with ${call.arguments.length} arguments`,
        call,
        "send(message[, callback]) is supported; handle transfer and options are not",
      );
    }
    const receiver = lowerer.lowerExpr(access.expression);
    const json = ipcJsonMessage(lowerer, call.arguments[0]!, loc);
    if (call.arguments[1] === undefined) {
      return { kind: "libCall", fn: "child.send", args: [receiver, json], type: BOOL, loc };
    }
    const callback = ipcSendCallback(lowerer, call.arguments[1]);
    return {
      kind: "libCall",
      fn: "child.sendCb",
      args: [receiver, json, callback],
      type: BOOL,
      loc,
    };
  }
  if (name === "disconnect" && call.arguments.length === 0) {
    if (!ts.isExpressionStatement(call.parent)) {
      lowerer.unsupported(
        "SC1090",
        call,
        "using the result of child.disconnect() (call it as its own statement)",
      );
    }
    return {
      kind: "libCall",
      fn: "child.disconnect",
      args: [lowerer.lowerExpr(access.expression)],
      type: VOID,
      loc,
    };
  }
  if ((name === "on" || name === "once") && call.arguments.length === 2) {
    const evT = lowerer.typeOf(call.arguments[0]!);
    const event = evT.isStringLiteralType() ? evT.value : null;
    if (
      event !== "spawn" &&
      event !== "exit" &&
      event !== "close" &&
      event !== "error" &&
      event !== "message" &&
      event !== "disconnect"
    ) {
      lowerer.noLowering(
        `child.${name}(${event === null ? "non-literal event" : `"${event}"`}, ...)`,
        call.arguments[0]!,
        '"exit", "close", "error", "message", and "disconnect" are the supported child events (as literals)',
      );
    }
    if (!ts.isExpressionStatement(call.parent)) {
      lowerer.unsupported(
        "SC1090",
        call,
        `chaining child.${name}(...) (the result is void here — register each listener as its own statement)`,
      );
    }
    const receiver = lowerer.lowerExpr(access.expression);
    const once: IrExpr = { kind: "boolLit", value: name === "once", type: BOOL, loc };
    if (event === "message") {
      return {
        kind: "libCall",
        fn: "child.onMessage",
        args: [receiver, ipcMessageListener(lowerer, call.arguments[1]!), once],
        type: VOID,
        loc,
      };
    }
    if (event === "disconnect") {
      return {
        kind: "libCall",
        fn: "child.onDisconnect",
        args: [receiver, ipcDisconnectListener(lowerer, call.arguments[1]!), once],
        type: VOID,
        loc,
      };
    }
    const listenerNode = stripTypeCasts(call.arguments[1]!);
    if (
      isJsSourceFile(listenerNode.getSourceFile()) &&
      (ts.isArrowFunction(listenerNode) || ts.isFunctionExpression(listenerNode)) &&
      listenerNode.parameters.some((param) => param.dotDotDotToken) &&
      listenerNode.parameters.every((param) => !param.type) &&
      !/@(?:param|type)\b/.test(
        listenerNode.getSourceFile().text.slice(listenerNode.pos, listenerNode.getStart()),
      )
    ) {
      for (const param of listenerNode.parameters) lowerer.checkedCallbackParams.add(param);
    }
    const cb = lowerer.lowerExpr(call.arguments[1]!);
    if (
      (isJsSourceFile(listenerNode.getSourceFile()) && cb.type.kind === "dyn") ||
      (cb.type.kind === "func" &&
        (cb.type.rest ||
          (isJsSourceFile(listenerNode.getSourceFile()) &&
            cb.type.params.some((param) => param.kind === "dyn"))))
    ) {
      if (
        cb.type.kind !== "dyn" &&
        !canBoxFuncIntoDyn(
          cb.type,
          (id) => lowerer.shapes.get(id),
          (id) => lowerer.unions.get(id),
        )
      ) {
        lowerer.noLowering(
          "child event listeners with non-representable parameters",
          call.arguments[1]!,
        );
      }
      return {
        kind: "libCall",
        fn: "child.onDyn",
        args: [
          receiver,
          { kind: "strLit", value: event, type: STRING, loc },
          cb.type.kind === "dyn" ? cb : { kind: "dynFrom", value: cb, type: DYN, loc },
        ],
        type: VOID,
        loc,
      };
    }
    if (event === "spawn") {
      if (cb.type.kind !== "func" || cb.type.params.length !== 0 || cb.type.ret.kind !== "void") {
        lowerer.noLowering(
          "spawn event listeners with parameters or a returned value",
          call.arguments[1]!,
        );
      }
      return { kind: "libCall", fn: "child.onSpawn", args: [receiver, cb], type: VOID, loc };
    }
    if (cb.type.kind !== "func" || cb.type.params.length > (event === "error" ? 1 : 2)) {
      lowerer.unsupported(
        "SC1090",
        call.arguments[1]!,
        event !== "error"
          ? `${event} listeners with more than two parameters (use (code, signal), (code), or ())`
          : "error listeners with more than one parameter (use (err) or ())",
      );
    }
    if (cb.type.ret.kind !== "void") {
      // `() => 5` IS assignable to a void-returning listener slot; the
      // registry's call ABI is void, so a value-returning closure is
      // fenced instead of being called through the wrong ABI.
      lowerer.unsupported(
        "SC1090",
        call.arguments[1]!,
        "listeners returning a value (make the callback body a block, or return nothing)",
      );
    }
    const param = cb.type.params[0];
    if (event === "exit" || event === "close") {
      const armsOk =
        param === undefined ||
        (param.kind === "union" &&
          (() => {
            const def = lowerer.unions.get(param.unionId);
            return (
              def?.arms.length === 2 && def.arms[0]!.kind === "f64" && def.arms[1]!.kind === "nullT"
            );
          })());
      if (!armsOk) {
        lowerer.unsupported(
          "SC1090",
          call.arguments[1]!,
          `${event} listeners whose parameter is not 'number | null' (got '${lowerer.fmt(param!)}')`,
        );
      }
      // The optional SECOND parameter is Node's signal: the terminating
      // signal's name as `Signals | null` — a string | null union here
      // (the interned adapter builds it at fire time).
      const sigParam = cb.type.params[1];
      const sigOk =
        sigParam === undefined ||
        (sigParam.kind === "union" &&
          (() => {
            const def = lowerer.unions.get(sigParam.unionId);
            return (
              def?.arms.length === 2 &&
              def.arms.some((a) => a.kind === "string") &&
              def.arms.some((a) => a.kind === "nullT")
            );
          })());
      if (!sigOk) {
        lowerer.unsupported(
          "SC1090",
          call.arguments[1]!,
          `${event} listeners whose signal parameter is not 'Signals | null' (got '${lowerer.fmt(sigParam!)}')`,
        );
      }
      return {
        kind: "libCall",
        fn: event === "close" ? "child.onClose" : "child.onExit",
        args: [receiver, cb],
        type: VOID,
        loc,
      };
    }
    if (param !== undefined && !(param.kind === "object" && param.className === "%Error")) {
      lowerer.unsupported(
        "SC1090",
        call.arguments[1]!,
        `error listeners whose parameter is not 'Error' (got '${lowerer.fmt(param)}')`,
      );
    }
    return { kind: "libCall", fn: "child.onError", args: [receiver, cb], type: VOID, loc };
  }
  // child.kill(signal?) — Node's semantics exactly: the name resolves
  // through Node's signal table (unknown names throw the ERR_UNKNOWN_SIGNAL
  // TypeError), numbers pass through (0 probes), the omitted signal is
  // SIGTERM; true when the signal was sent, false once the child was
  // reaped or never spawned (Node's null-handle answer), and a successful
  // send sets `killed`.
  if (name === "kill") {
    if (call.arguments.length > 1) {
      lowerer.noLowering(`child.kill with ${call.arguments.length} arguments`, call);
    }
    const receiver = lowerer.lowerExpr(access.expression);
    const sigNode = call.arguments[0];
    if (!sigNode) {
      const dflt: IrExpr = { kind: "strLit", value: "SIGTERM", type: STRING, loc };
      return { kind: "libCall", fn: "child.kill", args: [receiver, dflt], type: BOOL, loc };
    }
    const sig = lowerer.lowerExpr(sigNode);
    if (sig.type.kind === "f64") {
      return { kind: "libCall", fn: "child.killNum", args: [receiver, sig], type: BOOL, loc };
    }
    if (sig.type.kind === "string") {
      return { kind: "libCall", fn: "child.kill", args: [receiver, sig], type: BOOL, loc };
    }
    lowerer.noLowering(
      `child.kill with a '${lowerer.fmt(sig.type)}' signal`,
      sigNode,
      "pass a signal name string or number (narrow unions first)",
    );
  }
  // child.unref(): drops the child from the event loop's keep-alive set
  // (the process may exit while the child runs — Node's semantics; the
  // child is still reaped while the loop runs for other reasons).
  if ((name === "unref" || name === "ref") && call.arguments.length === 0) {
    const receiver = lowerer.lowerExpr(access.expression);
    return {
      kind: "libCall",
      fn: name === "ref" ? "child.ref" : "child.unref",
      args: [receiver],
      type: VOID,
      loc,
    };
  }
  lowerer.noLowering(
    `ChildProcess.${name}`,
    call,
    'send(), connected, disconnect(), on/once("message" | "disconnect" | "exit" | "close" | "error", cb), pid, exitCode, killed, kill(signal?), and unref() are supported',
    lowerer.checker.getSymbolAtLocation(access.name),
  );
}

/** Method calls on piped child-output stream receivers (child.stdout /
 * child.stderr — the childStream kind): on/once("data" | "end").
 * 'data' listeners take zero parameters, `(chunk: Buffer)`, or a
 * `Buffer | string`-union chunk (the ngrok appendOutput shape — the
 * runtime only ever fires Buffers; the compiler-emitted adapter wraps
 * the chunk at the union's Buffer arm); 'end' listeners take none.
 * Statement position only (Node returns the stream for chaining; here
 * the result is void). Chained receivers (`child.stdout?.on(...)`)
 * ride the optional-chain re-dispatch (chainBlocked). Everything else
 * @types/node declares on Readable fences member-qualified. Null for
 * non-stream receivers. */
export function lowerChildStreamMethodCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (lowerer.chainBlocked(call, access)) return null;
  if (lowerer.mapTypeOf(lowerer.typeOf(access.expression))?.kind !== "childStream") return null;
  if (!lowerer.isStdlibMember(access)) return null;
  const name = access.name.text;
  const loc = locOf(call);
  if (name === "setEncoding" && call.arguments.length === 1) {
    const receiver = lowerer.lowerExprExpecting(access.expression, CHILDSTREAM_T);
    const enc = bufEncoding(lowerer, "child stream setEncoding", call.arguments[0]!);
    return {
      kind: "libCall",
      fn: "stream.childSetEncoding",
      args: [receiver, strLit(enc, loc)],
      type: CHILDSTREAM_T,
      loc,
    };
  }
  if ((name === "on" || name === "once") && call.arguments.length === 2) {
    const evT = lowerer.typeOf(call.arguments[0]!);
    const event = evT.isStringLiteralType() ? evT.value : null;
    if (event !== "data" && event !== "end") {
      lowerer.noLowering(
        `stream.${name}(${event === null ? "non-literal event" : `"${event}"`}, ...)`,
        call.arguments[0]!,
        '"data" and "end" are the supported child-stream events (as literals)',
      );
    }
    if (!ts.isExpressionStatement(call.parent)) {
      lowerer.unsupported(
        "SC1090",
        call,
        "chaining stream listener registration (the result is void here — register each listener as its own statement)",
      );
    }
    const receiver = lowerer.lowerExpr(access.expression);
    const cb = lowerer.lowerExpr(call.arguments[1]!);
    const once: IrExpr = { kind: "boolLit", value: name === "once", type: BOOL, loc };
    if (
      cb.type.kind !== "func" ||
      cb.type.ret.kind !== "void" ||
      cb.type.params.length > (event === "data" ? 1 : 0)
    ) {
      lowerer.unsupported(
        "SC1090",
        call.arguments[1]!,
        event === "data"
          ? "data listeners with more than one parameter or a return value (use (chunk) or ())"
          : "end listeners with parameters or a return value (use ())",
      );
    }
    if (event === "end") {
      return { kind: "libCall", fn: "stream.onEnd", args: [receiver, cb, once], type: VOID, loc };
    }
    const param = cb.type.params[0];
    const unionOk = (p: IrType): boolean => {
      if (p.kind !== "union") return false;
      const def = lowerer.unions.get(p.unionId);
      return !!def && def.arms.some((a) => a.kind === "bytes" && a.elem === "u8");
    };
    if (
      param !== undefined &&
      param.kind !== "string" &&
      !(param.kind === "bytes" && param.elem === "u8") &&
      !unionOk(param)
    ) {
      lowerer.unsupported(
        "SC1090",
        call.arguments[1]!,
        `data listeners whose parameter is not 'Buffer', 'string', or a Buffer-armed union (got '${lowerer.fmt(param)}')`,
      );
    }
    return {
      kind: "libCall",
      fn: param?.kind === "string" ? "stream.onDataStr" : "stream.onData",
      args: [receiver, cb, once],
      type: VOID,
      loc,
    };
  }
  lowerer.noLowering(
    `ReadableStream.${name}`,
    call,
    'setEncoding(encoding) and on/once("data" | "end", cb) are the supported child-stream members',
    lowerer.checker.getSymbolAtLocation(access.name),
  );
}

/** Method calls on a piped child stdin writer. Writes copy one string or
 * Uint8Array into the nonblocking runtime queue and return the backpressure
 * signal. end()/destroy() are statement-only, as are drain/finish/error
 * listener registrations; unsupported callbacks/encodings stay fenced. */
export function lowerChildWriterMethodCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (lowerer.chainBlocked(call, access)) return null;
  if (lowerer.mapTypeOf(lowerer.typeOf(access.expression))?.kind !== "childWriter") return null;
  if (!lowerer.isStdlibMember(access)) return null;
  const name = access.name.text;
  const loc = locOf(call);

  if (name === "write") {
    if (call.arguments.length !== 1 || call.arguments.some(ts.isSpreadElement)) {
      lowerer.noLowering(
        `child stdin write with ${call.arguments.length} arguments`,
        call,
        "write(string | Uint8Array) with no encoding or callback is supported",
      );
    }
    const receiver = lowerer.lowerExprExpecting(access.expression, CHILDWRITER_T);
    const data = lowerer.lowerExpr(call.arguments[0]!);
    if (data.type.kind === "string") {
      return { kind: "libCall", fn: "writer.writeString", args: [receiver, data], type: BOOL, loc };
    }
    if (data.type.kind === "bytes" && data.type.elem === "u8") {
      return { kind: "libCall", fn: "writer.writeBytes", args: [receiver, data], type: BOOL, loc };
    }
    lowerer.noLowering(
      `child stdin write of '${lowerer.fmt(data.type)}'`,
      call.arguments[0]!,
      "write one string, Buffer, or Uint8Array value (narrow unions first)",
    );
  }

  if ((name === "end" || name === "destroy") && call.arguments.length === 0) {
    if (!ts.isExpressionStatement(call.parent)) {
      lowerer.unsupported(
        "SC1090",
        call,
        `chaining child.stdin.${name}() (call it as its own statement)`,
      );
    }
    const receiver = lowerer.lowerExprExpecting(access.expression, CHILDWRITER_T);
    return {
      kind: "libCall",
      fn: name === "end" ? "writer.end" : "writer.destroy",
      args: [receiver],
      type: VOID,
      loc,
    };
  }

  if ((name === "on" || name === "once") && call.arguments.length === 2) {
    const eventType = lowerer.typeOf(call.arguments[0]!);
    const event = eventType.isStringLiteralType() ? eventType.value : null;
    if (event !== "drain" && event !== "finish" && event !== "error") {
      lowerer.noLowering(
        `child stdin ${name}(${event === null ? "non-literal event" : `"${event}"`}, ...)`,
        call.arguments[0]!,
        '"drain", "finish", and "error" are the supported child stdin events',
      );
    }
    if (!ts.isExpressionStatement(call.parent)) {
      lowerer.unsupported("SC1090", call, "chaining child stdin listener registration");
    }
    const receiver = lowerer.lowerExprExpecting(access.expression, CHILDWRITER_T);
    const cb = lowerer.lowerExpr(call.arguments[1]!);
    const maxParams = event === "error" ? 1 : 0;
    if (
      cb.type.kind !== "func" ||
      cb.type.ret.kind !== "void" ||
      cb.type.params.length > maxParams
    ) {
      lowerer.unsupported(
        "SC1090",
        call.arguments[1]!,
        event === "error"
          ? "error listeners with at most one Error parameter and no return value"
          : `${event} listeners with no parameters or return value`,
      );
    }
    if (
      event === "error" &&
      cb.type.params[0] !== undefined &&
      !(cb.type.params[0]!.kind === "object" && cb.type.params[0]!.className === "%Error")
    ) {
      lowerer.unsupported(
        "SC1090",
        call.arguments[1]!,
        "child stdin error listeners whose parameter is Error",
      );
    }
    const once = boolLit(name === "once", loc);
    const fn =
      event === "drain"
        ? "writer.onDrain"
        : event === "finish"
          ? "writer.onFinish"
          : "writer.onError";
    return { kind: "libCall", fn, args: [receiver, cb, once], type: VOID, loc };
  }

  lowerer.noLowering(
    `Writable.${name}`,
    call,
    'write(string | Uint8Array), end(), destroy(), and on/once("drain" | "finish" | "error", cb) are supported',
    lowerer.checker.getSymbolAtLocation(access.name),
  );
}

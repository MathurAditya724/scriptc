import * as ts from "../../ts7/adapter.js";
import { type Lowerer } from "../lowerer.js";
import { locOf } from "../../program.js";
import { BOOL, type IrExpr, type IrType, STRING, type SrcLoc } from "../../../ir/ir.js";

/** Method calls on ChildProcess receivers: `child.on("exit"|"error", cb)`
 * registers a listener with the event loop's child registry. The event
 * name must be one of the two terminal-event LITERALS; the callback
 * takes at most one parameter — `(code: number | null)` for exit (the
 * signal parameter has no lowering), `(err: Error)` for error — or none.
 * `on` is statement-only (Node returns the child for chaining; here the
 * result is void and chaining is fenced). kill(signal?) and unref()
 * lower too (the property reads — pid/exitCode/killed — live in
 * lowerIntrinsicProperty). Everything else @types/node declares on
 * ChildProcess (stdout, once, ...) fences member-qualified. Null for
 * non-child receivers. */
function ignoredListenerReturn(type: IrType): boolean {
  return type.kind === "void" || (type.kind === "promise" && type.inner.kind === "void");
}

export function ipcJsonMessage(lowerer: Lowerer, node: ts.Expression, loc: SrcLoc): IrExpr {
  const value = lowerer.lowerExpr(node);
  if (!lowerer.jsonStringifySafe(value.type) && value.type.kind !== "dyn") {
    lowerer.unsupported(
      "SC1090",
      node,
      `IPC messages of '${lowerer.fmt(value.type)}' values (messages must be JSON-stringifiable records, arrays, primitives, unions of those, or unknown)`,
    );
  }
  return { kind: "jsonStringify", value, type: STRING, loc };
}

export function ipcMessageListener(lowerer: Lowerer, node: ts.Expression): IrExpr {
  const cb = lowerer.lowerExpr(node);
  if (cb.type.kind !== "func" || cb.type.params.length > 1 || !ignoredListenerReturn(cb.type.ret)) {
    lowerer.unsupported(
      "SC1090",
      node,
      "message listeners take zero or one parameter and may return void or Promise<void>",
    );
  }
  const param = cb.type.params[0];
  if (param !== undefined && param.kind !== "dyn" && !lowerer.jsonSafe(param)) {
    lowerer.unsupported(
      "SC1090",
      node,
      `message listeners whose parameter is not JSON-shaped or unknown (got '${lowerer.fmt(param)}')`,
    );
  }
  return cb;
}

export function ipcDisconnectListener(lowerer: Lowerer, node: ts.Expression): IrExpr {
  const cb = lowerer.lowerExpr(node);
  if (cb.type.kind !== "func" || cb.type.params.length !== 0 || cb.type.ret.kind !== "void") {
    lowerer.unsupported("SC1090", node, "disconnect listeners take no parameters and return void");
  }
  return cb;
}

export function ipcSendCallback(lowerer: Lowerer, node: ts.Expression): IrExpr {
  const cb = lowerer.lowerExpr(node);
  if (cb.type.kind !== "func" || cb.type.params.length > 1 || cb.type.ret.kind !== "void") {
    lowerer.unsupported(
      "SC1090",
      node,
      "send callbacks take () or (error: Error | null) and return void",
    );
  }
  const param = cb.type.params[0];
  if (param !== undefined) {
    const def = param.kind === "union" ? lowerer.unions.get(param.unionId) : undefined;
    const valid =
      !!def &&
      def.arms.length === 2 &&
      def.arms.some((arm) => arm.kind === "nullT") &&
      def.arms.some((arm) => arm.kind === "object" && arm.className === "%Error");
    if (!valid) {
      lowerer.unsupported(
        "SC1090",
        node,
        `send callbacks whose parameter is not 'Error | null' (got '${lowerer.fmt(param)}')`,
      );
    }
  }
  return cb;
}

export function lowerProcessIpcSend(lowerer: Lowerer, call: ts.CallExpression): IrExpr {
  const loc = locOf(call);
  if (
    call.arguments.nodes.length < 1 ||
    call.arguments.nodes.length > 2 ||
    call.arguments.nodes.some(ts.isSpreadElement)
  ) {
    lowerer.noLowering(
      `process.send with ${call.arguments.nodes.length} arguments`,
      call,
      "send(message[, callback]) is supported; handle transfer and options are not",
    );
  }
  const json = ipcJsonMessage(lowerer, call.arguments.nodes[0]!, loc);
  if (call.arguments.nodes[1] === undefined) {
    return { kind: "libCall", fn: "process.send", args: [json], type: BOOL, loc };
  }
  const callback = ipcSendCallback(lowerer, call.arguments.nodes[1]);
  return { kind: "libCall", fn: "process.sendCb", args: [json, callback], type: BOOL, loc };
}

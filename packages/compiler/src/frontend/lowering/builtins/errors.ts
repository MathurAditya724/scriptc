import * as ts from "../../ts7/adapter.js";
import { type Lowerer } from "../lowerer.js";
import { locOf } from "../../program.js";
import { DYN, F64, type IrExpr, STRING } from "../../../ir/ir.js";

const ASSERTION_ERROR_PROPERTIES: ReadonlySet<string> = new Set([
  "actual",
  "expected",
  "operator",
  "generatedMessage",
  "diff",
]);

/** `.code` and `.cause` on an error-hierarchy receiver. The latter reads
 * the hidden dyn slot installed by constructor options. The former is NodeJS.ErrnoException's
 * member (the fallback declares the same shape): the runtime Error's
 * code slot as `string | undefined` — the errno name where a throw site
 * stamped one (fs, exec spawn/timeout, process.kill, the spawn 'error'
 * event), undefined everywhere else. Stdlib provenance required (a user
 * class's own `code` field takes the ordinary field paths — its
 * declaration is not stdlib). Reads only: writes keep their fence (no
 * compiled program constructs an errno error). Null for non-error
 * receivers and non-stdlib members, so the chain keeps trying. */
/** True for child_process.ExecException, exec's callback error. Its
 * `code` is the child's numeric exit status (null after a signal), which
 * the runtime error's string code slot does not hold, so reads, `in` tests
 * and typeof tests of `code` refuse instead of answering from the slot. */
export function isExecExceptionType(lowerer: Lowerer, t: ts.Type): boolean {
  const sym = t.getSymbol();
  return (
    sym?.name === "ExecException" &&
    lowerer.checker
      .declarationsOf(sym)
      .some((d) => ts.isInterfaceDeclaration(d) && lowerer.isStdlibFile(d.getSourceFile()))
  );
}

export function refuseExecExceptionCode(lowerer: Lowerer, node: ts.Node): never {
  return lowerer.noLowering(
    "ExecException.code",
    node,
    "spawn reports the exit status through its 'close' event",
  );
}

export function lowerErrorCodeProperty(
  lowerer: Lowerer,
  expr: ts.PropertyAccessExpression,
): IrExpr | null {
  // `?.code` re-dispatches through the optional-chain machinery (the
  // mdns `(r.error as ErrnoException | undefined)?.code` idiom): the
  // chain-handled marker means the receiver already narrowed to the
  // non-unit arm and reads as chainRecv below.
  if (expr.questionDotToken && !lowerer.chainHandled.has(expr)) return null;
  const recvT = lowerer.mapTypeOf(lowerer.typeOf(expr.expression));
  if (recvT?.kind !== "object") return null;
  // %DOMException's OWN read surface first: `code` is the WebIDL legacy
  // NUMBER (never the errno string slot), and `cause` reads the options
  // form's stored value (Node's undefined when absent). Both live in
  // runtime slots beyond the ScrError prefix, reached by dedicated
  // libCalls.
  if (recvT.className === "%DOMException" && lowerer.isStdlibMember(expr)) {
    if (expr.name.text === "code") {
      const receiver = lowerer.lowerExpr(expr.expression);
      return {
        kind: "libCall",
        fn: "error.domCode",
        args: [receiver],
        type: F64,
        loc: locOf(expr),
      };
    }
    if (expr.name.text === "cause") {
      const receiver = lowerer.lowerExpr(expr.expression);
      return {
        kind: "libCall",
        fn: "error.domCause",
        args: [receiver],
        type: DYN,
        loc: locOf(expr),
      };
    }
  }
  // %AggregateError's `errors` list lives in the runtime slot beyond the
  // ScrError prefix; the read answers the same dyn array every time.
  if (
    recvT.className === "%AggregateError" &&
    expr.name.text === "errors" &&
    lowerer.isStdlibMember(expr)
  ) {
    const receiver = lowerer.lowerExpr(expr.expression);
    const loc = locOf(expr);
    // A narrowed checked-dynamic receiver reads its error view's property.
    if (receiver.type.kind === "dyn") {
      const key: IrExpr = { kind: "strLit", value: "errors", type: STRING, loc };
      return { kind: "dynKeyGet", value: receiver, key, type: DYN, loc };
    }
    return {
      kind: "libCall",
      fn: "error.aggregateErrors",
      args: [receiver],
      type: DYN,
      loc: locOf(expr),
    };
  }
  // %AssertionError's actual, expected, operator, generatedMessage and
  // diff, and %SuppressedError's error and suppressed, are properties of
  // the error's dyn view, read at the declared type.
  if (
    ((recvT.className === "%AssertionError" && ASSERTION_ERROR_PROPERTIES.has(expr.name.text)) ||
      (recvT.className === "%SuppressedError" &&
        (expr.name.text === "error" || expr.name.text === "suppressed"))) &&
    lowerer.isStdlibMember(expr)
  ) {
    const receiver = lowerer.lowerExpr(expr.expression);
    const loc = locOf(expr);
    const declared = lowerer.mapTypeOf(lowerer.typeOf(expr)) ?? DYN;
    return lowerer.coerceToExpected(
      {
        kind: "dynKeyGet",
        value: lowerer.coerceToExpected(receiver, DYN),
        key: { kind: "strLit", value: expr.name.text, type: STRING, loc },
        type: DYN,
        loc,
      },
      declared,
    );
  }
  const systemField = ["errno", "syscall", "path", "dest"].includes(expr.name.text);
  if (
    !systemField &&
    expr.name.text !== "code" &&
    expr.name.text !== "cause" &&
    expr.name.text !== "stack"
  )
    return null;
  // Error-rooted classes only — builtin or user subclass (both embed the
  // code and cause slots in their layout prefix).
  let info = lowerer.classes.get(recvT.className) ?? null;
  while (info && info.base) info = info.base;
  if (!info || info.def.name !== "%Error") return null;
  if (
    !lowerer.isStdlibMember(expr) &&
    !(recvT.className === "%Error" && lowerer.typeOf(expr.expression).isIntersectionType())
  )
    return null;
  if (expr.name.text === "code" && isExecExceptionType(lowerer, lowerer.typeOf(expr.expression))) {
    refuseExecExceptionCode(lowerer, expr);
  }
  const rawReceiver = lowerer.lowerExpr(expr.expression);
  const receiver =
    rawReceiver.type.kind === "dyn"
      ? lowerer.coerceInto(expr.expression, rawReceiver, recvT)
      : rawReceiver;
  if (systemField) {
    const loc = locOf(expr);
    return lowerer.coerceToExpected(
      {
        kind: "dynKeyGet",
        value: lowerer.coerceToExpected(receiver, DYN),
        key: { kind: "strLit", value: expr.name.text, type: STRING, loc },
        type: DYN,
        loc,
      },
      lowerer.withUndefinedArm(expr.name.text === "errno" ? F64 : STRING),
    );
  }
  return {
    kind: "libCall",
    fn:
      expr.name.text === "stack"
        ? "error.stack"
        : expr.name.text === "cause"
          ? "error.cause"
          : "error.code",
    args: [receiver],
    type:
      expr.name.text === "stack"
        ? STRING
        : expr.name.text === "cause"
          ? DYN
          : lowerer.envValueType(),
    loc: locOf(expr),
  };
}

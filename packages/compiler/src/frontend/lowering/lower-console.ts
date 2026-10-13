import * as ts from "../ts7/adapter.js";
import { BOOL, DYN, type IrExpr, type IrStmt, type SrcLoc, VOID } from "../../ir/ir.js";
import { boolLit, numLit, varRef } from "../../ir/build.js";
import { locOf } from "../program.js";
import { type Lowerer } from "./lowerer.js";
import { lowerFormatCall } from "./lower-inspect.js";
import { streamSidesOf } from "./lower-stream.js";

/** node:console Console instances: a native handle (the checked-dynamic
 * representation the stdlib Console type maps to) over two output
 * targets — process.stdout/process.stderr, or writable streams — plus
 * the ignoreErrors flag. The log/info/debug (stdout) and error/warn
 * (stderr) members lower through util.format into ONE write of the
 * formatted line, exactly Node's kWriteToConsole; the remaining Console
 * surface stays fenced like the global console's. */

const OUTPUT_MEMBERS: ReadonlyMap<string, boolean> = new Map([
  ["log", false],
  ["info", false],
  ["debug", false],
  ["error", true],
  ["warn", true],
]);

const OPTION_KEYS = new Set(["stdout", "stderr", "ignoreErrors"]);

function isConsoleCtor(lowerer: Lowerer, callee: ts.Expression): boolean {
  if (ts.isIdentifier(callee)) {
    const bi = lowerer.builtinImportOf(callee);
    return bi?.module === "console" && bi.member === "Console";
  }
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "Console") return false;
  return (
    lowerer.isStdlibGlobal(callee.expression, "console") ||
    lowerer.builtinNamespaceModuleOf(callee.expression) === "console"
  );
}

function isUndefinedArg(node: ts.Expression | undefined): boolean {
  return (
    node === undefined ||
    (ts.isIdentifier(node) && node.text === "undefined") ||
    ts.isVoidExpression(node)
  );
}

type Target = { fd: number } | { local: string };

/** `new Console(stdout[, stderr][, ignoreErrors])` and `new
 * Console({ stdout, stderr, ignoreErrors })`. Arguments evaluate in source
 * order into hidden locals before the handle exists (Node evaluates them
 * before the constructor body); an absent stderr shares stdout's target. */
export function lowerConsoleNew(lowerer: Lowerer, expr: ts.NewExpression): IrExpr | null {
  if (!isConsoleCtor(lowerer, expr.expression)) return null;
  const loc = locOf(expr);
  const args = expr.arguments ?? [];
  let stdoutNode: ts.Expression | undefined;
  let stderrNode: ts.Expression | undefined;
  let ignoreNode: ts.Expression | undefined;
  const first = args[0];
  if (first && ts.isObjectLiteralExpression(first)) {
    for (const prop of first.properties) {
      let name: string | null = null;
      let value: ts.Expression | null = null;
      if (
        ts.isPropertyAssignment(prop) &&
        (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))
      ) {
        name = (prop.name as ts.Identifier | ts.StringLiteral).text;
        value = prop.initializer;
      } else if (ts.isShorthandPropertyAssignment(prop)) {
        name = (prop.name as ts.Identifier).text;
        value = prop.name as ts.Identifier;
      }
      if (name === null || value === null || !OPTION_KEYS.has(name)) {
        lowerer.noLowering(
          "Console options other than stdout, stderr, and ignoreErrors",
          prop,
          "colorMode, inspectOptions, and groupIndentation have no lowering yet",
        );
      }
      if (name === "stdout") stdoutNode = value;
      else if (name === "stderr") stderrNode = value;
      else ignoreNode = value;
    }
  } else {
    [stdoutNode, stderrNode, ignoreNode] = args;
  }
  if (stdoutNode === undefined) {
    lowerer.noLowering("new Console without a stdout stream", expr, "pass the stdout stream");
  }
  const stmts: IrStmt[] = [];
  const target = (node: ts.Expression, role: string): Target => {
    if (ts.isPropertyAccessExpression(node)) {
      const member = lowerer.stdlibGlobalMember(node, "process");
      if (member === "stdout") return { fd: 1 };
      if (member === "stderr") return { fd: 2 };
    }
    const value = lowerer.lowerExpr(node);
    const info =
      value.type.kind === "object" ? lowerer.classes.get(value.type.className) : undefined;
    const sides = streamSidesOf(lowerer, info);
    if (sides !== "w" && sides !== "rw") {
      lowerer.noLowering(
        `a Console ${role} of type '${lowerer.fmt(value.type)}'`,
        node,
        "process.stdout, process.stderr, and node:stream writables (Writable, Duplex, Transform, PassThrough, and their subclasses) are the supported Console streams",
      );
    }
    const local = lowerer.declareHiddenLocal(`%console${role}`, value.type);
    stmts.push({ kind: "varDecl", localId: local.id, init: value, loc });
    return { local: local.id };
  };
  const out = target(stdoutNode, "stdout");
  const err = isUndefinedArg(stderrNode) ? out : target(stderrNode!, "stderr");
  let ignore: IrExpr = boolLit(true, loc);
  if (!isUndefinedArg(ignoreNode)) {
    const value = lowerer.lowerExpr(ignoreNode!);
    if (value.type.kind !== "bool") {
      lowerer.noLowering(
        `ignoreErrors of type '${lowerer.fmt(value.type)}'`,
        ignoreNode!,
        "pass a boolean",
      );
    }
    const local = lowerer.declareHiddenLocal("%consoleIgnoreErrors", BOOL);
    stmts.push({ kind: "varDecl", localId: local.id, init: value, loc });
    ignore = varRef(local.id, BOOL, loc);
  }
  const handle = lowerer.declareHiddenLocal("%console", DYN);
  const fdOf = (t: Target): IrExpr => numLit("fd" in t ? t.fd : 0, loc);
  stmts.push({
    kind: "varDecl",
    localId: handle.id,
    init: {
      kind: "libCall",
      fn: "console.new",
      args: [fdOf(out), fdOf(err), ignore],
      type: DYN,
      loc,
    },
    loc,
  });
  [out, err].forEach((t, which) => {
    if (!("local" in t)) return;
    const stream = stmts.find(
      (s): s is IrStmt & { kind: "varDecl" } => s.kind === "varDecl" && s.localId === t.local,
    )!;
    stmts.push({
      kind: "exprStmt",
      expr: {
        kind: "libCall",
        fn: "console.bind",
        args: [
          varRef(handle.id, DYN, loc),
          numLit(which, loc),
          varRef(t.local, stream.init!.type, loc),
        ],
        type: VOID,
        loc,
      },
      loc,
    });
  });
  return { kind: "seqExpr", stmts, result: varRef(handle.id, DYN, loc), type: DYN, loc };
}

/** `c.log(...)` and the other output members on a stdlib-Console-typed
 * receiver that is not the global console itself (that path keeps its
 * direct console lowering): the receiver evaluates first, then the
 * util.format rendering of the arguments, then one native write. */
export function lowerConsoleInstanceCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  loc: SrcLoc,
): IrExpr | null {
  if (call.questionDotToken || !ts.isPropertyAccessExpression(call.expression)) return null;
  const access = call.expression;
  if (access.questionDotToken) return null;
  const recvType = lowerer.typeOf(access.expression);
  const sym = recvType.getAliasSymbol() ?? recvType.getSymbol();
  if (!sym || sym.name !== "Console" || !lowerer.isStdlibSymbol(sym)) return null;
  const toStderr = OUTPUT_MEMBERS.get(access.name.text);
  if (toStderr === undefined) {
    lowerer.noLowering(
      `Console.${access.name.text}`,
      call,
      "log, info, debug, error, and warn are the lowered Console members",
    );
  }
  const receiver = lowerer.lowerExpr(access.expression);
  if (receiver.type.kind !== "dyn") return null;
  const formatted = lowerFormatCall(lowerer, call, loc, false);
  return {
    kind: "libCall",
    fn: "console.write",
    args: [receiver, formatted, boolLit(toStderr, loc)],
    type: VOID,
    loc,
  };
}

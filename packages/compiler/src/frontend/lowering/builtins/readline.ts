import * as ts from "../../ts7/adapter.js";
import { type Lowerer } from "../lowerer.js";
import { locOf } from "../../program.js";
import { DYN, F64, type IrExpr, type SrcLoc, STRING, VOID } from "../../../ir/ir.js";
import { boolLit, numLit } from "../../../ir/build.js";
import { READLINE_DOCUMENTED_OPTIONS, fenceOrDropOptionKey } from "../surfaces.js";
import { streamSidesOf } from "../lower-stream.js";

/** The ambient module declaring `d`, or null. */
function ambientModuleOf(d: ts.Node): string | null {
  let up: ts.Node | undefined = d.parent;
  while (up) {
    if (ts.isModuleDeclaration(up) && ts.isStringLiteral(up.name)) return up.name.text;
    up = up.parent;
  }
  return null;
}

function isReadlineModule(spec: string | null): boolean {
  return (
    spec === "readline" ||
    spec === "node:readline" ||
    spec === "readline/promises" ||
    spec === "node:readline/promises"
  );
}

/** True when `node`'s checker type is a readline Interface (stdlib
 * provenance + the enclosing "readline" or "readline/promises" ambient
 * module — the name alone is too generic). The interface maps to an f64
 * handle, so the IR type cannot discriminate it from a plain number. */
export function isReadlineTyped(lowerer: Lowerer, node: ts.Expression): boolean {
  const t = lowerer.checker.getTypeAtLocation(node);
  const sym = t.getAliasSymbol() ?? t.getSymbol();
  if (sym?.name !== "Interface") return false;
  return lowerer.checker.declarationsOf(sym).some((d) => {
    if (!ts.isClassDeclaration(d) && !ts.isInterfaceDeclaration(d)) return false;
    if (!lowerer.isStdlibFile(d.getSourceFile())) return false;
    return isReadlineModule(ambientModuleOf(d));
  });
}

/** The runtime's listener event numbers (scr_readline.c). */
const RL_EVENTS: Record<string, number> = { line: 0, close: 1, pause: 2, resume: 3, error: 4 };

/** True when the call's resolved signature answers a Promise — the
 * readline/promises question. */
function returnsPromise(lowerer: Lowerer, call: ts.CallExpression): boolean {
  const t = lowerer.checker.getTypeAtLocation(call);
  return (t.getSymbol()?.name ?? "") === "Promise";
}

/** The `{ signal }` options argument of the promise question: the signal
 * expression, or null when absent. Other members fence by name. */
function questionSignal(lowerer: Lowerer, node: ts.Expression | undefined): ts.Expression | null {
  if (node === undefined) return null;
  if (!ts.isObjectLiteralExpression(node)) {
    lowerer.noLowering(
      "readline/promises question options that are not an object literal",
      node,
      "write the options inline: question(query, { signal })",
    );
  }
  let signal: ts.Expression | null = null;
  for (const p of node.properties) {
    if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "signal") {
      signal = p.initializer;
      continue;
    }
    lowerer.noLowering(
      "readline/promises question with this option",
      p,
      "signal is the supported question option",
    );
  }
  return signal;
}

/** Method calls on readline Interface receivers (both modules):
 * - question(query, cb) — the callback form; question(query, { signal }?)
 *   — the promise form (readline/promises);
 * - close(), pause(), resume(), prompt(), setPrompt(p), getPrompt(),
 *   write(data);
 * - on/once/addListener for 'line' ((input: string) or no parameters),
 *   'close'/'pause'/'resume' (no parameters) and 'error' ((err: Error) or
 *   no parameters), as statements.
 * Everything else the lib declares fences member-qualified. Null for
 * non-Interface receivers. */
export function lowerReadlineMethodCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (call.questionDotToken || access.questionDotToken) return null;
  if (!isReadlineTyped(lowerer, access.expression)) return null;
  if (!lowerer.isStdlibMember(access)) return null;
  const name = access.name.text;
  const loc = locOf(call);
  const args = call.arguments;
  const receiver = (): IrExpr => lowerer.lowerExprExpecting(access.expression, F64);
  if (
    name === "question" &&
    returnsPromise(lowerer, call) &&
    args.length >= 1 &&
    args.length <= 2
  ) {
    const recv = receiver();
    const query = lowerer.lowerExprExpecting(args[0]!, STRING);
    const signal = questionSignal(lowerer, args[1]);
    const type = { kind: "promise", inner: STRING } as const;
    if (signal === null) {
      return { kind: "libCall", fn: "rl.questionAsync", args: [recv, query], type, loc };
    }
    const sig = lowerer.lowerExprExpecting(signal, DYN);
    return { kind: "libCall", fn: "rl.questionAsyncSignal", args: [recv, query, sig], type, loc };
  }
  if (name === "question" && args.length === 2) {
    const recv = receiver();
    const query = lowerer.lowerExprExpecting(args[0]!, STRING);
    const cb = lowerer.lowerExpr(args[1]!);
    if (cb.type.kind !== "func" || cb.type.ret.kind !== "void" || cb.type.params.length > 1) {
      lowerer.unsupported(
        "SC1090",
        args[1]!,
        "question callbacks with more than one parameter or a return value",
      );
    }
    const param = cb.type.params[0];
    if (param !== undefined && param.kind !== "string" && param.kind !== "dyn") {
      lowerer.unsupported(
        "SC1090",
        args[1]!,
        `question callbacks whose parameter is not 'string' (got '${lowerer.fmt(param)}')`,
      );
    }
    return { kind: "libCall", fn: "rl.question", args: [recv, query, cb], type: VOID, loc };
  }
  const simple: Record<string, "rl.close" | "rl.pause" | "rl.resume" | "rl.prompt"> = {
    close: "rl.close",
    pause: "rl.pause",
    resume: "rl.resume",
    prompt: "rl.prompt",
  };
  const simpleFn = simple[name];
  if (simpleFn !== undefined && (args.length === 0 || (name === "prompt" && args.length === 1))) {
    if ((name === "pause" || name === "resume") && !ts.isExpressionStatement(call.parent)) {
      lowerer.unsupported(
        "SC1090",
        call,
        `using the result of readline ${name}() (call it as its own statement)`,
      );
    }
    // prompt(preserveCursor) only moves the cursor of a terminal
    // interface: a boolean literal is accepted and has no effect here.
    const flag = args[0];
    if (
      flag !== undefined &&
      flag.kind !== ts.SyntaxKind.TrueKeyword &&
      flag.kind !== ts.SyntaxKind.FalseKeyword
    ) {
      lowerer.noLowering(
        "readline prompt() with a non-literal preserveCursor",
        flag,
        "preserveCursor only affects terminal interfaces — pass a boolean literal or omit it",
      );
    }
    return { kind: "libCall", fn: simpleFn, args: [receiver()], type: VOID, loc };
  }
  if (name === "setPrompt" && args.length === 1) {
    const recv = receiver();
    const prompt = lowerer.lowerExprExpecting(args[0]!, STRING);
    return { kind: "libCall", fn: "rl.setPrompt", args: [recv, prompt], type: VOID, loc };
  }
  if (name === "getPrompt" && args.length === 0) {
    return { kind: "libCall", fn: "rl.getPrompt", args: [receiver()], type: STRING, loc };
  }
  if (name === "write" && args.length === 1) {
    const recv = receiver();
    const data = lowerer.lowerExprExpecting(args[0]!, STRING);
    return { kind: "libCall", fn: "rl.write", args: [recv, data], type: VOID, loc };
  }
  if ((name === "on" || name === "once" || name === "addListener") && args.length === 2) {
    const evT = lowerer.typeOf(args[0]!);
    const event = evT.isStringLiteralType() ? evT.value : null;
    const ev = event === null ? undefined : RL_EVENTS[event];
    if (ev === undefined) {
      lowerer.noLowering(
        `readline.Interface.${name}(${event === null ? "non-literal event" : `"${event}"`}, ...)`,
        args[0]!,
        '"line", "close", "pause", "resume" and "error" are the supported readline events',
      );
    }
    if (!ts.isExpressionStatement(call.parent)) {
      lowerer.unsupported(
        "SC1090",
        call,
        "chaining readline listener registration (register each listener as its own statement)",
      );
    }
    const recv = receiver();
    const cb = lowerer.lowerExpr(args[1]!);
    const want = event === "line" ? "string" : event === "error" ? "error" : null;
    const param = cb.type.kind === "func" ? cb.type.params[0] : undefined;
    const paramOk =
      param === undefined ||
      (want !== null && param.kind === "dyn") ||
      (want === "string" && param.kind === "string") ||
      (want === "error" && param.kind === "object" && param.className === "Error");
    if (
      cb.type.kind !== "func" ||
      cb.type.ret.kind !== "void" ||
      cb.type.params.length > (want === null ? 0 : 1) ||
      !paramOk
    ) {
      lowerer.unsupported(
        "SC1090",
        args[1]!,
        want === "string"
          ? "'line' listeners other than (input: string) => void"
          : want === "error"
            ? "'error' listeners other than (err: Error) => void"
            : `'${event}' listeners with parameters or a return value (use ())`,
      );
    }
    return {
      kind: "libCall",
      fn: "rl.on",
      args: [recv, numLit(ev, loc), cb, boolLit(name === "once", loc)],
      type: VOID,
      loc,
    };
  }
  lowerer.noLowering(
    `readline.Interface.${name}`,
    call,
    "question, close, pause, resume, prompt, setPrompt, getPrompt, write, for await, and on/once for 'line', 'close', 'pause', 'resume' and 'error' are the supported Interface members",
    lowerer.checker.getSymbolAtLocation(access.name),
  );
}

/** The interface's input: process.stdin (null) or a readable stream. */
function lowerInput(lowerer: Lowerer, node: ts.Expression): IrExpr | null {
  if (
    ts.isPropertyAccessExpression(node) &&
    lowerer.stdlibGlobalMember(node, "process") === "stdin"
  ) {
    return null;
  }
  const v = lowerer.lowerExpr(node);
  const info = v.type.kind === "object" ? lowerer.classes.get(v.type.className) : undefined;
  const sides = streamSidesOf(lowerer, info);
  if (sides !== "r" && sides !== "rw") {
    lowerer.noLowering(
      "createInterface with this input",
      node,
      "process.stdin and readable streams are the supported inputs",
    );
  }
  return v;
}

/** The interface's output: "stdout", a writable stream, or "none". */
function lowerOutput(lowerer: Lowerer, node: ts.Expression): IrExpr | "stdout" | "none" {
  if (
    ts.isPropertyAccessExpression(node) &&
    lowerer.stdlibGlobalMember(node, "process") === "stdout"
  ) {
    return "stdout";
  }
  if (node.kind === ts.SyntaxKind.NullKeyword) {
    return "none";
  }
  if (ts.isIdentifier(node) && node.text === "undefined") return "none";
  const v = lowerer.lowerExpr(node);
  const info = v.type.kind === "object" ? lowerer.classes.get(v.type.className) : undefined;
  const sides = streamSidesOf(lowerer, info);
  if (sides !== "w" && sides !== "rw") {
    lowerer.noLowering(
      "createInterface with this output",
      node,
      "process.stdout and writable streams are the supported outputs",
    );
  }
  return v;
}

/** createInterface({ input, output?, terminal?: false, crlfDelay?,
 * prompt?, signal? }) or createInterface(input, output?), from
 * node:readline or node:readline/promises. The input is process.stdin
 * or a readable stream; the output process.stdout, a writable stream, or
 * absent (prompts are then not written). rl.create's arguments: the mode
 * literal (1 stream input, 2 stream output, 4 stdout output, 8 signal,
 * 16 prompt), then the input and output streams when present, crlfDelay,
 * the prompt and the signal when present. */
export function lowerReadlineCreateCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  loc: SrcLoc,
): IrExpr {
  let input: IrExpr | null = null;
  let output: IrExpr | "stdout" | "none" = "none";
  let crlf: IrExpr = numLit(0, loc);
  let prompt: IrExpr | null = null;
  let signal: IrExpr | null = null;
  const optsNode = expr.arguments[0];
  if (optsNode === undefined) {
    lowerer.noLowering(
      "createInterface without arguments",
      expr,
      "pass { input: process.stdin, output: process.stdout } or createInterface(input, output)",
    );
  }
  if (!ts.isObjectLiteralExpression(optsNode)) {
    if (expr.arguments.length > 2) {
      lowerer.noLowering(
        "createInterface with a completer or terminal argument",
        expr.arguments[2]!,
        "the positional form createInterface(input, output) is supported (terminal line editing has no lowering)",
      );
    }
    input = lowerInput(lowerer, optsNode);
    if (expr.arguments[1] !== undefined) output = lowerOutput(lowerer, expr.arguments[1]);
  } else {
    if (expr.arguments.length > 1) {
      lowerer.noLowering(
        "createInterface with more than one argument",
        expr.arguments[1]!,
        "pass every option in the one options object",
      );
    }
    let sawInput = false;
    for (const p of optsNode.properties) {
      if (!ts.isPropertyAssignment(p) || !ts.isIdentifier(p.name)) {
        lowerer.noLowering(
          "createInterface with this options shape",
          p,
          "spreads, computed keys, and shorthand options have no lowering — write each member inline",
        );
      }
      const member = p.name.text;
      if (member === "input") {
        input = lowerInput(lowerer, p.initializer);
        sawInput = true;
      } else if (member === "output") {
        output = lowerOutput(lowerer, p.initializer);
      } else if (member === "terminal") {
        const t = lowerer.typeOf(p.initializer);
        if (
          !(t.flags & ts.TypeFlags.BooleanLiteral) ||
          lowerer.checker.typeToString(t) !== "false"
        ) {
          lowerer.noLowering(
            "createInterface with terminal enabled",
            p.initializer,
            "terminal line editing has no lowering — the pipe behavior is what compiles",
          );
        }
      } else if (member === "crlfDelay") {
        crlf = lowerer.lowerExprExpecting(p.initializer, F64);
      } else if (member === "prompt") {
        prompt = lowerer.lowerExprExpecting(p.initializer, STRING);
      } else if (member === "signal") {
        signal = lowerer.lowerExprExpecting(p.initializer, DYN);
      } else if (member === "completer") {
        lowerer.noLowering(
          "createInterface with a completer",
          p,
          "tab completion needs an interactive terminal — the lowered interface reads piped lines (terminal: false)",
        );
      } else {
        fenceOrDropOptionKey(
          lowerer,
          p,
          member,
          "createInterface",
          READLINE_DOCUMENTED_OPTIONS,
          "input, output, terminal: false, crlfDelay, prompt and signal are the supported options",
        );
        // An undocumented key, dropped like Node drops it.
      }
    }
    if (!sawInput) {
      lowerer.noLowering(
        "createInterface without an input stream",
        optsNode,
        "pass { input: process.stdin, output: process.stdout }",
      );
    }
  }
  const mode =
    (input !== null ? 1 : 0) |
    (typeof output === "object" ? 2 : 0) |
    (output === "stdout" ? 4 : 0) |
    (signal !== null ? 8 : 0) |
    (prompt !== null ? 16 : 0);
  const args: IrExpr[] = [numLit(mode, loc)];
  if (input !== null) args.push(input);
  if (typeof output === "object") args.push(output);
  args.push(crlf);
  if (prompt !== null) args.push(prompt);
  if (signal !== null) args.push(signal);
  return {
    kind: "libCall",
    fn: signal !== null ? "rl.createSignal" : "rl.create",
    args,
    type: F64,
    loc,
  };
}

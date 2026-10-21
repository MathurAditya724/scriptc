/* Own properties that JavaScript adds to a native ChildProcess: execa's
 * mixin assigns `spawned.kill = ...` and defines then/catch/finally with
 * Reflect.defineProperty, and its callers await the child as a thenable.
 *
 * The runtime keeps such properties in a side table per child
 * (scr_dyn_handle_props.c). Only programs that can add one link it: a
 * JavaScript write of a property onto a typed child, or JavaScript that
 * calls defineProperty in a program whose JavaScript loads child_process. Those programs install the table at
 * start, and their defineProperty, getOwnPropertyDescriptor, thenable
 * await and typed `child.on(event, listener)` calls take the entries that
 * consult it. Every other program lowers exactly as before. */
import * as ts from "../ts7/adapter.js";
import { isJsSourceFile, locOf } from "../program.js";
import type { IrExpr, IrFunction, IrLibFn, IrStmt, SrcLoc } from "../../ir/ir.js";
import { DYN, STRING, VOID } from "../../ir/ir.js";
import { everyStmt } from "../../ir/traverse.js";
import { tryLowerExpression } from "./expressions/try-lower-expression.js";
import { ENTRY_NAME, type Lowerer } from "./lowerer.js";

/** `child.name = value` in a JavaScript file over a typed child: the write
 * lands in the child's property table through its checked-dynamic box. */
export function lowerChildPropertyWrite(
  lowerer: Lowerer,
  recv: IrExpr,
  target: ts.PropertyAccessExpression,
  value: ts.Expression,
  loc: SrcLoc,
): IrStmt {
  lowerer.writesOntoChildren = true;
  return {
    kind: "exprStmt",
    expr: {
      kind: "libCall",
      fn: "dyn.keySet",
      args: [
        lowerer.coerceToExpected(recv, DYN),
        { kind: "strLit", value: target.name.text, type: STRING, loc },
        lowerer.lowerExprExpecting(value, DYN),
      ],
      type: VOID,
      loc,
    },
    loc,
  };
}

/** `child.kill` as a value in a JavaScript file (`spawned.kill.bind(spawned)`):
 * the method read off the child's checked-dynamic box, which answers a
 * function acting on that child. */
export function lowerChildMethodValue(lowerer: Lowerer, node: ts.Expression): IrExpr | null {
  if (!ts.isPropertyAccessExpression(node) || node.questionDotToken) return null;
  if (!isJsSourceFile(ts.getSourceFileOfNode(node))) return null;
  const recv = tryLowerExpression(lowerer, node.expression);
  if (recv?.type.kind !== "child") return null;
  lowerer.writesOntoChildren = true;
  const loc = locOf(node);
  return {
    kind: "dynKeyGet",
    value: lowerer.coerceToExpected(recv, DYN),
    key: { kind: "strLit", value: node.name.text, type: STRING, loc },
    type: DYN,
    loc,
  };
}

/** ChildProcess and EventEmitter member names: reads and calls of these on
 * a typed child keep their typed lowering (or its diagnostic) unless the
 * program assigns the name onto a child. */
const CHILD_MEMBERS: ReadonlySet<string> = new Set([
  "addListener",
  "channel",
  "connected",
  "disconnect",
  "emit",
  "eventNames",
  "exitCode",
  "getMaxListeners",
  "kill",
  "killed",
  "listenerCount",
  "listeners",
  "off",
  "on",
  "once",
  "pid",
  "prependListener",
  "prependOnceListener",
  "rawListeners",
  "ref",
  "removeAllListeners",
  "removeListener",
  "send",
  "setMaxListeners",
  "signalCode",
  "spawnargs",
  "spawnfile",
  "stderr",
  "stdin",
  "stdio",
  "stdout",
  "unref",
]);

interface ChildAdditions {
  /** Names JavaScript assigns onto typed children. */
  written: ReadonlySet<string>;
  /** Whether the program can add properties to children at all. */
  any: boolean;
}

/** What the program's JavaScript adds to children: `child.name = value`
 * writes onto typed children in any JavaScript file of a program that
 * loads child_process, and defineProperty calls in such a program. */
function childAdditions(lowerer: Lowerer): ChildAdditions {
  let known = lowerer.childAdditions;
  if (known) return known;
  const written = new Set<string>();
  const files = lowerer.program
    .getImplementationSourceFiles()
    .filter((sf) => !sf.isDeclarationFile && isJsSourceFile(sf));
  const spawns = files.some((sf) => sf.text.includes("child_process"));
  const defines = files.some((sf) => sf.text.includes("defineProperty"));
  // A child can reach any module (`module.exports = (child) => { child.x =
  // ... }`), so once some file loads child_process every JavaScript file's
  // writes onto children count.
  for (const sf of spawns ? files : []) {
    const visit = (node: ts.Node): void => {
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(node.left) &&
        lowerer.mapTypeOf(lowerer.typeOf(node.left.expression))?.kind === "child"
      ) {
        written.add(node.left.name.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  known = { written, any: written.size > 0 || (spawns && defines) };
  lowerer.childAdditions = known;
  return known;
}

/** The typed child a JavaScript member access reads from, when the member
 * is one the program may have added to it. `untyped` is the last resort
 * when no typed lowering claimed the access (a receiver the checker does
 * not type as a child, such as an untyped parameter the call site
 * instantiated with one, or a member without a typed lowering): every
 * member goes through the child's box. */
function childReceiverOf(
  lowerer: Lowerer,
  access: ts.PropertyAccessExpression,
  untyped: boolean,
): IrExpr | null {
  if (access.questionDotToken || !isJsSourceFile(ts.getSourceFileOfNode(access))) return null;
  const additions = childAdditions(lowerer);
  const typed = lowerer.mapTypeOf(lowerer.typeOf(access.expression))?.kind === "child";
  if (!untyped && (!typed || !additions.any)) return null;
  const name = access.name.text;
  if (!untyped && CHILD_MEMBERS.has(name) && !additions.written.has(name)) return null;
  const recv = tryLowerExpression(lowerer, access.expression);
  if (recv?.type.kind !== "child") return null;
  if (additions.any) lowerer.writesOntoChildren = true;
  return recv;
}

/** `child.name(...)` in JavaScript for a name the program adds to children
 * (execa's `spawned.then(...)`, its replaced `spawned.kill(...)`), or on an
 * untyped receiver holding a child (`untyped`): a member call on the
 * child's checked-dynamic box. */
export function lowerChildPropertyCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
  untyped = false,
): IrExpr | null {
  if (call.questionDotToken || call.arguments.nodes.some(ts.isSpreadElement)) return null;
  const child = childReceiverOf(lowerer, access, untyped);
  // `spawned.stdin.on(...)` over an untyped child: the member read off
  // the child's box, then the call on that value.
  const recv: IrExpr | null = child
    ? lowerer.coerceToExpected(child, DYN)
    : untyped && ts.isPropertyAccessExpression(access.expression)
      ? lowerChildPropertyRead(lowerer, access.expression)
      : null;
  if (!recv) return null;
  const loc = locOf(call);
  return {
    kind: "dynInvoke",
    recv,
    method: access.name.text,
    calleeName: ts.getTextOfNode(access),
    args: call.arguments.nodes.map((arg) => lowerer.lowerExprExpecting(arg, DYN)),
    type: DYN,
    loc,
  };
}

/** `child.name` in JavaScript over an untyped receiver holding a child, or
 * for a name the program adds to children. */
export function lowerChildPropertyRead(
  lowerer: Lowerer,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  const recv = childReceiverOf(lowerer, access, true) ?? childReceiverOf(lowerer, access, false);
  if (!recv) return null;
  const loc = locOf(access);
  return {
    kind: "dynKeyGet",
    value: lowerer.coerceToExpected(recv, DYN),
    key: { kind: "strLit", value: access.name.text, type: STRING, loc },
    type: DYN,
    loc,
  };
}

/** `await child` in JavaScript in a program that adds properties to
 * children: the child may be a thenable (execa's mixin). */
export function awaitsChildThenable(lowerer: Lowerer, node: ts.Node, value: IrExpr): boolean {
  if (
    value.type.kind !== "child" ||
    !isJsSourceFile(ts.getSourceFileOfNode(node)) ||
    !childAdditions(lowerer).any
  )
    return false;
  lowerer.writesOntoChildren = true;
  return true;
}

const RENAMES: ReadonlyMap<IrLibFn, IrLibFn> = new Map<IrLibFn, IrLibFn>([
  ["dyn.defineProperty", "child.propsDefine"],
  ["dyn.getOwnPropertyDescriptor", "child.propsDescriptor"],
  ["dyn.promiseResolve", "child.propsResolve"],
  ["child.onDyn", "child.propsOnDyn"],
]);

/** Switches a program that can add properties to children onto the
 * property-table entries (in place) and installs the table in %main. */
export function applyHandleProperties(lowerer: Lowerer, functions: IrFunction[]): void {
  if (!lowerer.writesOntoChildren && !childAdditions(lowerer).any) return;
  const calls: (IrExpr & { kind: "libCall" })[] = [];
  const visitor = {
    expr: (e: IrExpr): boolean => {
      if (e.kind === "libCall" && RENAMES.has(e.fn)) calls.push(e);
      return true;
    },
    stmt: (): boolean => true,
  };
  for (const fn of functions) for (const s of fn.body) everyStmt(s, visitor);
  for (const call of calls) (call as { fn: IrLibFn }).fn = RENAMES.get(call.fn)!;
  const main = functions.find((fn) => fn.name === ENTRY_NAME);
  if (!main) return;
  const loc = main.loc;
  main.body.unshift({
    kind: "exprStmt",
    expr: { kind: "libCall", fn: "child.propsInstall", args: [], type: VOID, loc },
    loc,
  });
}

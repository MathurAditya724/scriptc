import { varRef } from "../../../ir/build.js";
import * as ts from "../../ts7/adapter.js";
import { type Lowerer } from "../lowerer.js";
import { locOf } from "../../program.js";
import { builtinModuleFnOf } from "../surfaces.js";
import { BOOL, DYN, type IrExpr, STRING, arrayOf } from "../../../ir/ir.js";

/** Reflect.ownKeys uses native computed-key reflection. Reflect.apply(target,
 * thisArg, argsList) where the TARGET is a builtin
 * rest-parameter table fn (path.join / path.resolve — test/common
 * fixtures.js's fixturesPath forwards its rest args exactly this way):
 * the packed libCall over a validated string[] extraction of argsList.
 * The builtins ignore the receiver, so thisArg must be an effect-free
 * spelling (`this`, an identifier, a unit literal) whose dropped
 * evaluation is unobservable; every other Reflect.apply keeps the
 * fence. Null when this isn't a supported Reflect call. */
export function lowerReflectCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (
    !call.questionDotToken &&
    !access.questionDotToken &&
    lowerer.stdlibGlobalMember(access, "Reflect") === "ownKeys" &&
    call.arguments.nodes.length === 1 &&
    !ts.isSpreadElement(call.arguments.nodes[0]!)
  ) {
    return {
      kind: "libCall",
      fn: "dyn.ownKeys",
      args: [lowerer.lowerExprExpecting(call.arguments.nodes[0]!, DYN)],
      type: DYN,
      loc: locOf(call),
    };
  }
  if (call.questionDotToken) return null;
  const reflectMember = lowerer.stdlibGlobalMember(access, "Reflect");
  if (reflectMember === "get" || reflectMember === "set") {
    const required = reflectMember === "get" ? 2 : 3;
    if (
      call.arguments.nodes.length < required ||
      call.arguments.nodes.length > required + 1 ||
      call.arguments.nodes.some(ts.isSpreadElement)
    ) {
      lowerer.noLowering(
        `Reflect.${reflectMember} with this argument shape`,
        call,
        `use Reflect.${reflectMember}(target, key${reflectMember === "set" ? ", value" : ""}, receiver?)`,
      );
    }
    const loc = locOf(call);
    const args = call.arguments.nodes.map((arg) => lowerer.lowerExprExpecting(arg, DYN));
    const target =
      call.arguments.nodes.length === required
        ? lowerer.declareHiddenLocal("%reflectTarget", DYN)
        : null;
    const operation: IrExpr = {
      kind: "libCall",
      fn: reflectMember === "get" ? "dyn.reflectGet" : "dyn.reflectSet",
      args: target
        ? [varRef(target.id, DYN, loc), ...args.slice(1), varRef(target.id, DYN, loc)]
        : args,
      type: reflectMember === "get" ? DYN : BOOL,
      loc,
    };
    return target
      ? {
          kind: "seqExpr",
          stmts: [{ kind: "varDecl", localId: target.id, init: args[0]!, loc }],
          result: operation,
          type: operation.type,
          loc,
        }
      : operation;
  }
  if (lowerer.stdlibGlobalMember(access, "Reflect") !== "apply") return null;
  const loc = locOf(call);
  const fenceHint =
    "the lowered form is Reflect.apply(path.join | path.resolve, <effect-free this>, args) — call other functions directly (f(...args))";
  if (call.arguments.nodes.length !== 3 || call.arguments.nodes.some(ts.isSpreadElement)) {
    lowerer.noLowering("Reflect.apply with this argument shape", call, fenceHint);
  }
  const targetNode = call.arguments.nodes[0]!;
  const bi = ts.isPropertyAccessExpression(targetNode) ? lowerer.builtinMemberOf(targetNode) : null;
  const fn = bi ? builtinModuleFnOf(lowerer, bi.module, bi.member) : null;
  if (!fn || fn.variadicPack !== true) {
    const target = lowerer.lowerExprExpecting(targetNode, DYN);
    const receiver = lowerer.lowerExprExpecting(call.arguments.nodes[1]!, DYN);
    const argumentsList = lowerer.lowerExprExpecting(call.arguments.nodes[2]!, DYN);
    return {
      kind: "libCall",
      fn: "dyn.reflectApply",
      args: [target, receiver, argumentsList],
      type: DYN,
      loc,
    };
  }
  const thisNode = call.arguments.nodes[1]!;
  const effectFree =
    thisNode.kind === ts.SyntaxKind.ThisKeyword ||
    ts.isIdentifier(thisNode) ||
    thisNode.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(thisNode) && thisNode.text === "undefined");
  if (!effectFree) {
    lowerer.noLowering(
      "Reflect.apply with a computed thisArg",
      thisNode,
      "the target ignores its receiver, so only effect-free spellings drop honestly (`this`, a binding, null, undefined)",
    );
  }
  const packed = lowerer.lowerExprExpecting(call.arguments.nodes[2]!, arrayOf(STRING));
  return { kind: "libCall", fn: fn.fn, args: [packed], type: fn.result, loc };
}

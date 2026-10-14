import { dynUndefinedExpr, varRef } from "../../ir/build.js";
import {
  DYN,
  STRING,
  canConvertToDyn,
  canDynCheckTo,
  typeEquals,
  typeKey,
  type IrExpr,
  type IrFunction,
  type IrStmt,
  type IrType,
} from "../../ir/ir.js";
import { locOf } from "../program.js";
import * as ts from "../ts7/adapter.js";
import { type Lowerer } from "./lowerer.js";
import { findMethodOn, upcastTo, type ClassInfo } from "./lower-classes.js";
import { isClassCallback } from "./class-callbacks.js";

/** A method call through a class-backed protocol (`s.area()` with
 * `s: Shape`) that keeps its static signature. ClassDynamicDispatch adds
 * one native arm to `fn` per boxed class implementing the method; other
 * values take `fallback`, the checked-dynamic call. */
export interface ProtocolDispatch {
  method: string;
  /** (receiver, [callee], ...args, calleeName) → result. Generated: its
   * capsule tests and unboxing stay as written. */
  fn: IrFunction;
  /** The same signature as `fn`, lowered as ordinary code so property
   * reads and checks dispatch like the call they replace. */
  fallback: IrFunction;
  /** Reads the callee before arguments run, for argument lists with
   * effects. Native arms answer undefined without reading it. */
  probe: IrFunction | null;
  params: IrType[];
  /** The call's static result; DYN for a void protocol method, whose
   * implementations may still return a value. */
  result: IrType;
  returnsVoid: boolean;
  classes: Set<string>;
}

/** Arguments whose evaluation can neither throw nor change any value, so
 * the callee read may follow them. */
function effectFree(expr: IrExpr): boolean {
  const scalar = (value: IrExpr): boolean =>
    (value.type.kind === "f64" || value.type.kind === "bool") && effectFree(value);
  switch (expr.kind) {
    case "varRef":
    case "numLit":
    case "strLit":
    case "boolLit":
    case "unitLit":
      return true;
    case "bin":
      return scalar(expr.left) && scalar(expr.right);
    case "unary":
      return scalar(expr.operand);
    default:
      return false;
  }
}

interface ProtocolSignature {
  params: IrType[];
  result: IrType;
  returnsVoid: boolean;
}

/** The protocol method's parameter and result types, when every parameter
 * is plain (no rest, optional or default) and every type maps. */
function protocolSignature(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): ProtocolSignature | null {
  const recvTs = lowerer.typeOf(access.expression);
  const property = lowerer.checker.getPropertyOfType(recvTs, access.name.text);
  if (!property) return null;
  const declarations = lowerer.checker.declarationsOf(property);
  if (
    declarations.length === 0 ||
    !declarations.every(
      (decl) => ts.isMethodSignatureDeclaration(decl) || ts.isMethodDeclaration(decl),
    )
  )
    return null;
  const signature = lowerer.checker.getResolvedSignature(call);
  const declaration = signature && lowerer.checker.signatureDeclaration(signature);
  if (
    !signature ||
    !declaration ||
    !(ts.isMethodSignatureDeclaration(declaration) || ts.isMethodDeclaration(declaration)) ||
    (declaration.typeParameters?.length ?? 0) > 0
  )
    return null;
  const declared = (declaration.parameters ?? []).filter(
    (param) => !(ts.isIdentifier(param.name) && param.name.text === "this"),
  );
  const symbols = signature.getParameters();
  if (symbols.length !== declared.length || call.arguments.length !== declared.length) return null;
  const records = (id: string) => lowerer.shapes.get(id);
  const unions = (id: string) => lowerer.unions.get(id);
  const params: IrType[] = [];
  for (let i = 0; i < declared.length; i++) {
    const param = declared[i]!;
    if (param.dotDotDotToken || param.questionToken || param.initializer) return null;
    const mapped = lowerer.mapTypeOf(lowerer.checker.getTypeOfSymbol(symbols[i]!));
    if (!mapped || mapped.kind === "void" || !canConvertToDyn(mapped, records, unions)) return null;
    params.push(mapped);
  }
  const returned = lowerer.checker.getReturnTypeOfSignature(signature);
  if ((returned.flags & ts.TypeFlags.Void) !== 0) return { params, result: DYN, returnsVoid: true };
  const result = lowerer.mapTypeOf(returned);
  if (!result || result.kind === "void" || !canDynCheckTo(result, records, unions)) return null;
  return { params, result, returnsVoid: false };
}

/** `s.m(args)` on a class-backed protocol receiver: the arguments and the
 * result keep their static types, and receivers that are instances of a
 * boxed implementing class call the native method directly. */
export function lowerProtocolMethodCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
  recv: IrExpr,
): IrExpr | null {
  if (
    recv.type.kind !== "dyn" ||
    call.questionDotToken ||
    access.questionDotToken ||
    call.arguments.some(ts.isSpreadElement)
  )
    return null;
  let signature: ProtocolSignature | null;
  try {
    signature = protocolSignature(lowerer, call, access);
  } catch {
    return null;
  }
  if (!signature) return null;
  const { params, result, returnsVoid } = signature;
  const loc = locOf(call);
  const method = access.name.text;
  const receiverLocal = lowerer.declareHiddenLocal("%protocolReceiver", DYN);
  const receiver = varRef(receiverLocal.id, DYN, loc);
  const stmts: IrStmt[] = [{ kind: "varDecl", localId: receiverLocal.id, init: recv, loc }];
  const args = call.arguments.map((arg, i) =>
    lowerer.coerceToExpected(lowerer.lowerExprExpecting(arg, params[i]!), params[i]!),
  );
  const probed = !args.every(effectFree);
  const key = JSON.stringify([method, params.map(typeKey), typeKey(result), returnsVoid, probed]);
  let dispatch = lowerer.protocolDispatches.get(key);
  if (!dispatch) {
    const index = lowerer.protocolDispatches.size;
    const signatureParams = [
      { localId: "p.0", name: "receiver", type: DYN },
      ...(probed ? [{ localId: "p.callee", name: "callee", type: DYN }] : []),
      ...params.map((type, i) => ({ localId: `p.${i + 1}`, name: `p${i + 1}`, type })),
      { localId: "p.calleeName", name: "calleeName", type: STRING },
    ];
    const locals = () =>
      signatureParams.map((param) => ({
        id: param.localId,
        name: param.name,
        type: param.type,
        mutable: false,
      }));
    const read = (): IrExpr => ({
      kind: "dynKeyGet",
      value: varRef("p.0", DYN, loc),
      key: { kind: "strLit", value: method, type: STRING, loc },
      type: DYN,
      loc,
    });
    const dynamicCall: IrExpr = {
      kind: "dynCall",
      callee: probed ? varRef("p.callee", DYN, loc) : read(),
      receiver: varRef("p.0", DYN, loc),
      calleeName: access.getText(),
      calleeNameValue: varRef("p.calleeName", STRING, loc),
      args: params.map((type, i) => lowerer.coerceToExpected(varRef(`p.${i + 1}`, type, loc), DYN)),
      type: DYN,
      loc,
    };
    const fallback: IrFunction = {
      name: `%dyn.class.protocol.fallback.${index}`,
      params: signatureParams,
      returnType: result,
      locals: locals(),
      body: [{ kind: "return", value: lowerer.coerceToExpected(dynamicCall, result), loc }],
      loc,
    };
    const fn: IrFunction = {
      name: `%dyn.class.protocol.${index}`,
      params: signatureParams,
      returnType: result,
      locals: locals(),
      body: [
        {
          kind: "return",
          value: {
            kind: "call",
            callee: fallback.name,
            args: signatureParams.map((param) => varRef(param.localId, param.type, loc)),
            type: result,
            loc,
          },
          loc,
        },
      ],
      loc,
    };
    const probe: IrFunction | null = probed
      ? {
          name: `%dyn.class.protocol.callee.${index}`,
          params: [signatureParams[0]!],
          returnType: DYN,
          locals: [{ id: "p.0", name: "receiver", type: DYN, mutable: false }],
          body: [{ kind: "return", value: read(), loc }],
          loc,
        }
      : null;
    dispatch = {
      method,
      fn,
      fallback,
      probe,
      params,
      result,
      returnsVoid,
      classes: new Set(),
    };
    lowerer.protocolDispatches.set(key, dispatch);
    lowerer.liftedFns.push(fn, fallback, ...(probe ? [probe] : []));
  }
  const callee = dispatch.probe ? lowerer.declareHiddenLocal("%protocolCallee", DYN) : null;
  if (dispatch.probe && callee)
    stmts.push({
      kind: "varDecl",
      localId: callee.id,
      init: { kind: "call", callee: dispatch.probe.name, args: [receiver], type: DYN, loc },
      loc,
    });
  return {
    kind: "seqExpr",
    stmts,
    result: {
      kind: "call",
      callee: dispatch.fn.name,
      args: [
        receiver,
        ...(callee ? [varRef(callee.id, DYN, loc)] : []),
        ...args,
        { kind: "strLit", value: access.getText(), type: STRING, loc },
      ],
      type: result,
      loc,
    },
    type: result,
    loc,
  };
}

/** The native arm for receivers of `info`: the method's own signature must
 * accept the protocol's argument types unchanged (or as one checked-dynamic
 * value), and nothing may replace the method on an instance. */
export function protocolArm(
  lowerer: Lowerer,
  dispatch: ProtocolDispatch,
  info: ClassInfo,
  receiver: IrExpr,
  asyncFree: boolean,
): IrStmt[] | null {
  const { method } = dispatch;
  const loc = dispatch.fn.loc;
  if (
    info.def.runtime ||
    info.builtinError ||
    info.builtinEmitter ||
    info.builtinStream ||
    isClassCallback(lowerer, info, method)
  )
    return null;
  const found = findMethodOn(lowerer, info, method);
  if (!found || (asyncFree && (found.sig.gen || found.sig.async))) return null;
  const records = (id: string) => lowerer.shapes.get(id);
  const unions = (id: string) => lowerer.unions.get(id);
  const { params } = found.sig;
  if (params.length !== dispatch.params.length) return null;
  const args: IrExpr[] = [];
  for (let i = 0; i < params.length; i++) {
    const param = params[i]!;
    const incoming = varRef(`p.${i + 1}`, dispatch.params[i]!, loc);
    if (param.mode !== "required" && param.mode !== "omittable") return null;
    if (typeEquals(param.type, incoming.type)) args.push(incoming);
    else if (param.type.kind === "dyn") args.push(lowerer.coerceToExpected(incoming, DYN));
    else return null;
  }
  const owner = found.declarer;
  const virtual = lowerer.overrideBelow(owner, method) || found.sig.abstract === true;
  const callee = `%${owner.def.name}.${method}`;
  const ret = found.sig.ret;
  const invoke: IrExpr = virtual
    ? {
        kind: "virtualCall",
        className: owner.def.name,
        method,
        args: [upcastTo(lowerer, receiver, owner.def.name), ...args],
        type: ret,
        loc,
      }
    : {
        kind: "call",
        callee,
        args: [upcastTo(lowerer, receiver, owner.def.name), ...args],
        type: ret,
        loc,
      };
  let body: IrStmt[];
  if (ret.kind === "void") {
    if (!dispatch.returnsVoid) return null;
    body = [
      { kind: "exprStmt", expr: invoke, loc },
      { kind: "return", value: dynUndefinedExpr(loc), loc },
    ];
  } else if (typeEquals(ret, dispatch.result)) {
    body = [{ kind: "return", value: invoke, loc }];
  } else if (dispatch.result.kind === "dyn" && canConvertToDyn(ret, records, unions)) {
    body = [{ kind: "return", value: lowerer.coerceToExpected(invoke, DYN), loc }];
  } else return null;
  if (virtual) lowerer.noteVirtualEdge(owner, method);
  else lowerer.noteEdge(callee);
  return body;
}

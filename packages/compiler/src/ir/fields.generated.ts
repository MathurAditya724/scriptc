// Generated from packages/compiler/src/ir/ir.ts by scripts/generate-ir-fields.mjs.
// Run `pnpm generate:ir-fields` after changing the fields of an IR node.
import type { IrExpr, IrStmt, IrType } from "./ir.js";

/** Calls `visit` with each string field of `node` (including `kind`) and its
 * name: the string values `for (const key in node)` finds on a node, read
 * by name in the order ir.ts declares them. */
export function eachStringField(
  node: IrExpr | IrStmt,
  visit: (value: string, field: string) => void,
): void {
  switch (node.kind) {
    case "arrIntrinsic": {
      visit(node.kind, "kind");
      visit(node.method, "method");
      return;
    }
    case "arrayDelete": {
      visit(node.kind, "kind");
      return;
    }
    case "arrayGet": {
      visit(node.kind, "kind");
      return;
    }
    case "arrayHas": {
      visit(node.kind, "kind");
      return;
    }
    case "arrayLit": {
      visit(node.kind, "kind");
      return;
    }
    case "arrayNewLen": {
      visit(node.kind, "kind");
      return;
    }
    case "arraySet": {
      visit(node.kind, "kind");
      return;
    }
    case "arraySetLength": {
      visit(node.kind, "kind");
      return;
    }
    case "arraySetUndefined": {
      visit(node.kind, "kind");
      return;
    }
    case "arrayState": {
      visit(node.kind, "kind");
      return;
    }
    case "assign": {
      visit(node.kind, "kind");
      visit(node.localId, "localId");
      return;
    }
    case "assignExpr": {
      visit(node.kind, "kind");
      visit(node.localId, "localId");
      return;
    }
    case "awaitExpr": {
      visit(node.kind, "kind");
      return;
    }
    case "awaitUnionExpr": {
      visit(node.kind, "kind");
      return;
    }
    case "bin": {
      visit(node.kind, "kind");
      visit(node.op, "op");
      return;
    }
    case "block": {
      visit(node.kind, "kind");
      return;
    }
    case "boolLit": {
      visit(node.kind, "kind");
      return;
    }
    case "break": {
      visit(node.kind, "kind");
      if (typeof node.label === "string") visit(node.label, "label");
      return;
    }
    case "bytesIntrinsic": {
      visit(node.kind, "kind");
      visit(node.method, "method");
      return;
    }
    case "bytesNew": {
      visit(node.kind, "kind");
      return;
    }
    case "bytesSet": {
      visit(node.kind, "kind");
      return;
    }
    case "call": {
      visit(node.kind, "kind");
      visit(node.callee, "callee");
      return;
    }
    case "callValue": {
      visit(node.kind, "kind");
      return;
    }
    case "caughtCheck": {
      visit(node.kind, "kind");
      visit(node.className, "className");
      return;
    }
    case "caughtNarrow": {
      visit(node.kind, "kind");
      return;
    }
    case "caughtTest": {
      visit(node.kind, "kind");
      visit(node.test, "test");
      if (typeof node.className === "string") visit(node.className, "className");
      return;
    }
    case "caughtToDyn": {
      visit(node.kind, "kind");
      return;
    }
    case "chainRecv": {
      visit(node.kind, "kind");
      visit(node.id, "id");
      return;
    }
    case "classRef": {
      visit(node.kind, "kind");
      visit(node.className, "className");
      return;
    }
    case "closure": {
      visit(node.kind, "kind");
      visit(node.fnName, "fnName");
      return;
    }
    case "continue": {
      visit(node.kind, "kind");
      if (typeof node.label === "string") visit(node.label, "label");
      return;
    }
    case "doWhile": {
      visit(node.kind, "kind");
      return;
    }
    case "downcast": {
      visit(node.kind, "kind");
      return;
    }
    case "dynArrLit": {
      visit(node.kind, "kind");
      return;
    }
    case "dynCall": {
      visit(node.kind, "kind");
      visit(node.calleeName, "calleeName");
      return;
    }
    case "dynCheck": {
      visit(node.kind, "kind");
      if (typeof node.inferredSite === "string") visit(node.inferredSite, "inferredSite");
      return;
    }
    case "dynDestrCheck": {
      visit(node.kind, "kind");
      visit(node.spelling, "spelling");
      if (typeof node.firstProp === "string") visit(node.firstProp, "firstProp");
      return;
    }
    case "dynFrom": {
      visit(node.kind, "kind");
      if (typeof node.fnName === "string") visit(node.fnName, "fnName");
      return;
    }
    case "dynHasKey": {
      visit(node.kind, "kind");
      visit(node.key, "key");
      return;
    }
    case "dynInvoke": {
      visit(node.kind, "kind");
      visit(node.method, "method");
      visit(node.calleeName, "calleeName");
      return;
    }
    case "dynIterN": {
      visit(node.kind, "kind");
      if (typeof node.notIterableMessage === "string") visit(node.notIterableMessage, "notIterableMessage");
      return;
    }
    case "dynKeyGet": {
      visit(node.kind, "kind");
      return;
    }
    case "dynObjLit": {
      visit(node.kind, "kind");
      return;
    }
    case "dynScalarEq": {
      visit(node.kind, "kind");
      return;
    }
    case "dynTest": {
      visit(node.kind, "kind");
      visit(node.test, "test");
      if (typeof node.bytesElem === "string") visit(node.bytesElem, "bytesElem");
      return;
    }
    case "exprStmt": {
      visit(node.kind, "kind");
      return;
    }
    case "ffiCall": {
      visit(node.kind, "kind");
      visit(node.import, "import");
      return;
    }
    case "fieldAbsent": {
      visit(node.kind, "kind");
      visit(node.unionId, "unionId");
      return;
    }
    case "fieldGet": {
      visit(node.kind, "kind");
      visit(node.className, "className");
      visit(node.field, "field");
      return;
    }
    case "fieldIncDec": {
      visit(node.kind, "kind");
      visit(node.op, "op");
      visit(node.className, "className");
      visit(node.field, "field");
      return;
    }
    case "fieldSet": {
      visit(node.kind, "kind");
      visit(node.className, "className");
      visit(node.field, "field");
      return;
    }
    case "for": {
      visit(node.kind, "kind");
      return;
    }
    case "forOf": {
      visit(node.kind, "kind");
      visit(node.localId, "localId");
      return;
    }
    case "genResume": {
      visit(node.kind, "kind");
      visit(node.mode, "mode");
      return;
    }
    case "if": {
      visit(node.kind, "kind");
      return;
    }
    case "incDec": {
      visit(node.kind, "kind");
      visit(node.op, "op");
      visit(node.localId, "localId");
      return;
    }
    case "instanceOf": {
      visit(node.kind, "kind");
      visit(node.className, "className");
      return;
    }
    case "instanceOfValue": {
      visit(node.kind, "kind");
      return;
    }
    case "intrinsic": {
      visit(node.kind, "kind");
      visit(node.name, "name");
      return;
    }
    case "jsonStringify": {
      visit(node.kind, "kind");
      if (typeof node.indent === "string") visit(node.indent, "indent");
      return;
    }
    case "libCall": {
      visit(node.kind, "kind");
      visit(node.fn, "fn");
      return;
    }
    case "logical": {
      visit(node.kind, "kind");
      visit(node.op, "op");
      return;
    }
    case "mapIntrinsic": {
      visit(node.kind, "kind");
      visit(node.method, "method");
      return;
    }
    case "mapNew": {
      visit(node.kind, "kind");
      return;
    }
    case "moduleNsRef": {
      visit(node.kind, "kind");
      visit(node.moduleId, "moduleId");
      return;
    }
    case "new": {
      visit(node.kind, "kind");
      visit(node.className, "className");
      return;
    }
    case "newPromise": {
      visit(node.kind, "kind");
      return;
    }
    case "newValue": {
      visit(node.kind, "kind");
      return;
    }
    case "nullish": {
      visit(node.kind, "kind");
      return;
    }
    case "numLit": {
      visit(node.kind, "kind");
      if (typeof node.spelling === "string") visit(node.spelling, "spelling");
      return;
    }
    case "optChain": {
      visit(node.kind, "kind");
      visit(node.id, "id");
      return;
    }
    case "orDefault": {
      visit(node.kind, "kind");
      if (typeof node.retag === "string") visit(node.retag, "retag");
      return;
    }
    case "promiseVoidWiden": {
      visit(node.kind, "kind");
      return;
    }
    case "promiseWithResolvers": {
      visit(node.kind, "kind");
      return;
    }
    case "recordClone": {
      visit(node.kind, "kind");
      return;
    }
    case "recordGet": {
      visit(node.kind, "kind");
      visit(node.shapeId, "shapeId");
      visit(node.field, "field");
      return;
    }
    case "recordHas": {
      visit(node.kind, "kind");
      visit(node.shapeId, "shapeId");
      visit(node.field, "field");
      return;
    }
    case "recordKeyDelete": {
      visit(node.kind, "kind");
      visit(node.shapeId, "shapeId");
      return;
    }
    case "recordKeyGet": {
      visit(node.kind, "kind");
      visit(node.shapeId, "shapeId");
      return;
    }
    case "recordKeySet": {
      visit(node.kind, "kind");
      visit(node.shapeId, "shapeId");
      return;
    }
    case "recordLit": {
      visit(node.kind, "kind");
      return;
    }
    case "recordNullProto": {
      visit(node.kind, "kind");
      visit(node.shapeId, "shapeId");
      return;
    }
    case "recordOvfHas": {
      visit(node.kind, "kind");
      visit(node.shapeId, "shapeId");
      return;
    }
    case "recordOvfKeys": {
      visit(node.kind, "kind");
      visit(node.shapeId, "shapeId");
      return;
    }
    case "recordSet": {
      visit(node.kind, "kind");
      visit(node.shapeId, "shapeId");
      visit(node.field, "field");
      return;
    }
    case "regexIntrinsic": {
      visit(node.kind, "kind");
      visit(node.method, "method");
      return;
    }
    case "regexLit": {
      visit(node.kind, "kind");
      visit(node.pattern, "pattern");
      visit(node.flags, "flags");
      return;
    }
    case "rethrow": {
      visit(node.kind, "kind");
      visit(node.localId, "localId");
      return;
    }
    case "return": {
      visit(node.kind, "kind");
      return;
    }
    case "runtimeFence": {
      visit(node.kind, "kind");
      visit(node.code, "code");
      visit(node.message, "message");
      return;
    }
    case "selfRef": {
      visit(node.kind, "kind");
      return;
    }
    case "seqExpr": {
      visit(node.kind, "kind");
      return;
    }
    case "setIntrinsic": {
      visit(node.kind, "kind");
      visit(node.method, "method");
      return;
    }
    case "setNew": {
      visit(node.kind, "kind");
      return;
    }
    case "strCmp": {
      visit(node.kind, "kind");
      visit(node.op, "op");
      return;
    }
    case "strConcat": {
      visit(node.kind, "kind");
      return;
    }
    case "strEq": {
      visit(node.kind, "kind");
      return;
    }
    case "strIntrinsic": {
      visit(node.kind, "kind");
      visit(node.method, "method");
      return;
    }
    case "strLit": {
      visit(node.kind, "kind");
      visit(node.value, "value");
      return;
    }
    case "switch": {
      visit(node.kind, "kind");
      return;
    }
    case "templateStrings": {
      visit(node.kind, "kind");
      visit(node.key, "key");
      return;
    }
    case "ternary": {
      visit(node.kind, "kind");
      return;
    }
    case "throw": {
      visit(node.kind, "kind");
      return;
    }
    case "toBool": {
      visit(node.kind, "kind");
      return;
    }
    case "toString": {
      visit(node.kind, "kind");
      return;
    }
    case "tryCatch": {
      visit(node.kind, "kind");
      if (typeof node.catchLocalId === "string") visit(node.catchLocalId, "catchLocalId");
      return;
    }
    case "unary": {
      visit(node.kind, "kind");
      visit(node.op, "op");
      return;
    }
    case "unionDisc": {
      visit(node.kind, "kind");
      visit(node.unionId, "unionId");
      visit(node.field, "field");
      return;
    }
    case "unionEq": {
      visit(node.kind, "kind");
      visit(node.unionId, "unionId");
      return;
    }
    case "unionFuncEq": {
      visit(node.kind, "kind");
      visit(node.unionId, "unionId");
      return;
    }
    case "unionIsTag": {
      visit(node.kind, "kind");
      visit(node.unionId, "unionId");
      return;
    }
    case "unionKeyGet": {
      visit(node.kind, "kind");
      visit(node.unionId, "unionId");
      return;
    }
    case "unionNarrow": {
      visit(node.kind, "kind");
      visit(node.unionId, "unionId");
      return;
    }
    case "unionRetype": {
      visit(node.kind, "kind");
      visit(node.fromId, "fromId");
      visit(node.unionId, "unionId");
      return;
    }
    case "unionWrap": {
      visit(node.kind, "kind");
      visit(node.unionId, "unionId");
      return;
    }
    case "unitLit": {
      visit(node.kind, "kind");
      visit(node.unit, "unit");
      return;
    }
    case "upcast": {
      visit(node.kind, "kind");
      return;
    }
    case "varDecl": {
      visit(node.kind, "kind");
      visit(node.localId, "localId");
      return;
    }
    case "varRef": {
      visit(node.kind, "kind");
      visit(node.localId, "localId");
      return;
    }
    case "virtualCall": {
      visit(node.kind, "kind");
      visit(node.className, "className");
      visit(node.method, "method");
      return;
    }
    case "while": {
      visit(node.kind, "kind");
      return;
    }
    case "yieldExpr": {
      visit(node.kind, "kind");
      return;
    }
  }
}

/** What a field walk reports (walkExprFields): each expression and
 * statement node before its fields, and each string a field holds. */
export interface IrFieldWalker {
  node(node: IrExpr | IrStmt): void;
  string(value: string): void;
}

/** Walks every field of `node` but `loc` (and `type` with `skipType`), and
 * every field of each object under it: the strings and nodes a recursive
 * `for (const key in value)` walk with the same skips finds, read by name in
 * the order ir.ts declares the fields. */
export function walkExprFields(node: IrExpr, walker: IrFieldWalker, skipType: boolean): void {
  walker.node(node);
  switch (node.kind) {
    case "arrIntrinsic": {
      walker.string(node.kind);
      walker.string(node.method);
      walkExprFields(node.receiver, walker, skipType);
      for (const item0 of node.args) {
        walkExprFields(item0, walker, skipType);
      }
      if (!skipType) {
        walkTypeFields(node.type, walker, skipType);
      }
      return;
    }
    case "arrayGet": {
      walker.string(node.kind);
      walkExprFields(node.arr, walker, skipType);
      walkExprFields(node.index, walker, skipType);
      if (!skipType) {
        walkTypeFields(node.type, walker, skipType);
      }
      return;
    }
    case "arrayHas": {
      walker.string(node.kind);
      walkExprFields(node.arr, walker, skipType);
      walkExprFields(node.index, walker, skipType);
      if (!skipType) {
        walkTypeFields(node.type, walker, skipType);
      }
      return;
    }
    case "arrayLit": {
      walker.string(node.kind);
      for (const item1 of node.elems) {
        walkExprFields(item1, walker, skipType);
      }
      if (node.spreads !== undefined && node.spreads !== null) {
        for (const item2 of node.spreads) {
        }
      }
      if (!skipType) {
        walkTypeFields(node.type, walker, skipType);
      }
      return;
    }
    case "arrayNewLen": {
      walker.string(node.kind);
      walkExprFields(node.length, walker, skipType);
      if (!skipType) {
        walkTypeFields(node.type, walker, skipType);
      }
      return;
    }
    case "arrayState": {
      walker.string(node.kind);
      walkExprFields(node.arr, walker, skipType);
      walkExprFields(node.index, walker, skipType);
      if (!skipType) {
        walkTypeFields(node.type, walker, skipType);
      }
      return;
    }
    case "assignExpr": {
      walker.string(node.kind);
      walker.string(node.localId);
      walkExprFields(node.value, walker, skipType);
      if (!skipType) {
        walkTypeFields(node.type, walker, skipType);
      }
      return;
    }
    case "awaitExpr": {
      walker.string(node.kind);
      walkExprFields(node.value, walker, skipType);
      if (!skipType) {
        walkTypeFields(node.type, walker, skipType);
      }
      return;
    }
    case "awaitUnionExpr": {
      walker.string(node.kind);
      walkExprFields(node.value, walker, skipType);
      if (!skipType) {
        walkTypeFields(node.type, walker, skipType);
      }
      return;
    }
    case "bin": {
      walker.string(node.kind);
      walker.string(node.op);
      walkExprFields(node.left, walker, skipType);
      walkExprFields(node.right, walker, skipType);
      if (!skipType) {
        walkTypeFields(node.type, walker, skipType);
      }
      return;
    }
    case "boolLit": {
      walker.string(node.kind);
      if (!skipType) {
        walkTypeFields(node.type, walker, skipType);
      }
      return;
    }
    case "bytesIntrinsic": {
      walker.string(node.kind);
      walker.string(node.method);
      walkExprFields(node.receiver, walker, skipType);
      for (const item3 of node.args) {
        walkExprFields(item3, walker, skipType);
      }
      if (!skipType) {
        walkTypeFields(node.type, walker, skipType);
      }
      return;
    }
    case "bytesNew": {
      walker.string(node.kind);
      if (node.source !== undefined && node.source !== null) {
        walkExprFields(node.source, walker, skipType);
      }
      if (!skipType) {
        walkTypeFields(node.type, walker, skipType);
      }
      return;
    }
    case "call": {
      walker.string(node.kind);
      walker.string(node.callee);
      for (const item4 of node.args) {
        walkExprFields(item4, walker, skipType);
      }
      if (!skipType) {
        walkTypeFields(node.type, walker, skipType);
      }
      return;
    }
    case "callValue": {
      walker.string(node.kind);
      walkExprFields(node.callee, walker, skipType);
      if (node.receiver !== undefined && node.receiver !== null) {
        walkExprFields(node.receiver, walker, skipType);
      }
      for (const item5 of node.args) {
        walkExprFields(item5, walker, skipType);
      }
      if (!skipType) {
        walkTypeFields(node.type, walker, skipType);
      }
      return;
    }
    case "caughtCheck": {
      walker.string(node.kind);
      walkExprFields(node.value, walker, skipType);
      walker.string(node.className);
      if (!skipType) {
        walkTypeFields(node.type, walker, skipType);
      }
      return;
    }
    case "caughtNarrow": {
      walker.string(node.kind);
      walkExprFields(node.value, walker, skipType);
      if (!skipType) {
        walkTypeFields(node.type, walker, skipType);
      }
      return;
    }
    case "caughtTest": {
      walker.string(node.kind);
      walkExprFields(node.value, walker, skipType);
      walker.string(node.test);
      if (node.className !== undefined && node.className !== null) {
        walker.string(node.className);
      }
      if (!skipType) {
        walkTypeFields(node.type, walker, skipType);
      }
      return;
    }
    case "caughtToDyn": {
      walker.string(node.kind);
      walkExprFields(node.value, walker, skipType);
      if (!skipType) {
        walkTypeFields(node.type, walker, skipType);
      }
      return;
    }
    case "chainRecv": {
      walker.string(node.kind);
      walker.string(node.id);
      if (!skipType) {
        walkTypeFields(node.type, walker, skipType);
      }
      return;
    }
    case "classRef": {
      walker.string(node.kind);
      walker.string(node.className);
      if (node.captures !== undefined && node.captures !== null) {
        for (const item6 of node.captures) {
          walker.string(item6);
        }
      }
      if (!skipType) {
        walkTypeFields(node.type, walker, skipType);
      }
      return;
    }
    case "closure": {
      walker.string(node.kind);
      walker.string(node.fnName);
      for (const item7 of node.captures) {
        walker.string(item7);
      }
      if (!skipType) {
        walkTypeFields(node.type, walker, skipType);
      }
      return;
    }
    case "downcast": {
      walker.string(node.kind);
      walkExprFields(node.value, walker, skipType);
      if (!skipType) {
        walkTypeFields(node.type, walker, skipType);
      }
      return;
    }
    case "dynArrLit": {
      walker.string(node.kind);
      for (const item8 of node.elems) {
        walkExprFields(item8, walker, skipType);
      }
      if (!skipType) {
        walkTypeFields(node.type, walker, skipType);
      }
      return;
    }
    case "dynCall": {
      walker.string(node.kind);
      walkExprFields(node.callee, walker, skipType);
      if (node.receiver !== undefined && node.receiver !== null) {
        walkExprFields(node.receiver, walker, skipType);
      }
      walker.string(node.calleeName);
      if (node.calleeNameValue !== undefined && node.calleeNameValue !== null) {
        walkExprFields(node.calleeNameValue, walker, skipType);
      }
      for (const item9 of node.args) {
        walkExprFields(item9, walker, skipType);
      }
      if (node.spreads !== undefined && node.spreads !== null) {
        for (const item10 of node.spreads) {
          walker.string(item10.what);
        }
      }
      if (!skipType) {
        walkTypeFields(node.type, walker, skipType);
      }
      return;
    }
    case "dynCheck": {
      walker.string(node.kind);
      walkExprFields(node.value, walker, skipType);
      if (node.inferredSite !== undefined && node.inferredSite !== null) {
        walker.string(node.inferredSite);
      }
      if (!skipType) {
        walkTypeFields(node.type, walker, skipType);
      }
      return;
    }
    case "dynDestrCheck": {
      walker.string(node.kind);
      walkExprFields(node.value, walker, skipType);
      walker.string(node.spelling);
      if (node.firstProp !== undefined && node.firstProp !== null) {
        walker.string(node.firstProp);
      }
      if (!skipType) {
        walkTypeFields(node.type, walker, skipType);
      }
      return;
    }
    case "dynFrom": {
      walker.string(node.kind);
      walkExprFields(node.value, walker, skipType);
      if (node.fnName !== undefined && node.fnName !== null) {
        walker.string(node.fnName);
      }
      if (!skipType) {
        walkTypeFields(node.type, walker, skipType);
      }
      return;
    }
    case "dynHasKey": {
      walker.string(node.kind);
      walker.string(node.key);
      walkExprFields(node.value, walker, skipType);
      if (!skipType) {
        walkTypeFields(node.type, walker, skipType);
      }
      return;
    }
    case "dynInvoke": {
      walker.string(node.kind);
      walkExprFields(node.recv, walker, skipType);
      walker.string(node.method);
      walker.string(node.calleeName);
      if (node.calleeNameValue !== undefined && node.calleeNameValue !== null) {
        walkExprFields(node.calleeNameValue, walker, skipType);
      }
      for (const item11 of node.args) {
        walkExprFields(item11, walker, skipType);
      }
      if (!skipType) {
        walkTypeFields(node.type, walker, skipType);
      }
      return;
    }
    case "dynIterN": {
      walker.string(node.kind);
      walkExprFields(node.value, walker, skipType);
      if (node.notIterableMessage !== undefined && node.notIterableMessage !== null) {
        walker.string(node.notIterableMessage);
      }
      if (!skipType) {
        walkTypeFields(node.type, walker, skipType);
      }
      return;
    }
    case "dynKeyGet": {
      walker.string(node.kind);
      walkExprFields(node.key, walker, skipType);
      walkExprFields(node.value, walker, skipType);
      if (!skipType) {
        walkTypeFields(node.type, walker, skipType);
      }
      return;
    }
    case "dynObjLit": {
      walker.string(node.kind);
      if (node.fields !== undefined && node.fields !== null) {
        for (const item12 of node.fields) {
          walkExprFields(item12.key, walker, skipType);
          walkExprFields(item12.value, walker, skipType);
        }
      }
      if (!skipType) {
        walkTypeFields(node.type, walker, skipType);
      }
      return;
    }
    case "dynScalarEq": {
      walker.string(node.kind);
      walkExprFields(node.left, walker, skipType);
      walkExprFields(node.right, walker, skipType);
      if (!skipType) {
        walkTypeFields(node.type, walker, skipType);
      }
      return;
    }
    case "dynTest": {
      walker.string(node.kind);
      walker.string(node.test);
      if (node.bytesElem !== undefined && node.bytesElem !== null) {
        walker.string(node.bytesElem);
      }
      walkExprFields(node.value, walker, skipType);
      if (!skipType) {
        walkTypeFields(node.type, walker, skipType);
      }
      return;
    }
    case "ffiCall": {
      walker.string(node.kind);
      walker.string(node.import);
      for (const item13 of node.args) {
        walkExprFields(item13, walker, skipType);
      }
      if (!skipType) {
        walkTypeFields(node.type, walker, skipType);
      }
      return;
    }
    case "fieldAbsent": {
      walker.string(node.kind);
      walker.string(node.unionId);
      if (!skipType) {
        walkTypeFields(node.type, walker, skipType);
      }
      return;
    }
    case "fieldGet": {
      walker.string(node.kind);
      walkExprFields(node.obj, walker, skipType);
      walker.string(node.className);
      walker.string(node.field);
      if (!skipType) {
        walkTypeFields(node.type, walker, skipType);
      }
      return;
    }
    case "fieldIncDec": {
      walker.string(node.kind);
      walker.string(node.op);
      walkExprFields(node.obj, walker, skipType);
      walker.string(node.className);
      walker.string(node.field);
      if (!skipType) {
        walkTypeFields(node.type, walker, skipType);
      }
      return;
    }
    case "genResume": {
      walker.string(node.kind);
      walker.string(node.mode);
      walkExprFields(node.gen, walker, skipType);
      if (node.arg !== undefined && node.arg !== null) {
        walkExprFields(node.arg, walker, skipType);
      }
      if (!skipType) {
        walkTypeFields(node.type, walker, skipType);
      }
      return;
    }
    case "incDec": {
      walker.string(node.kind);
      walker.string(node.op);
      walker.string(node.localId);
      if (!skipType) {
        walkTypeFields(node.type, walker, skipType);
      }
      return;
    }
    case "instanceOf": {
      walker.string(node.kind);
      walkExprFields(node.value, walker, skipType);
      walker.string(node.className);
      if (!skipType) {
        walkTypeFields(node.type, walker, skipType);
      }
      return;
    }
    case "instanceOfValue": {
      walker.string(node.kind);
      walkExprFields(node.value, walker, skipType);
      walkExprFields(node.classValue, walker, skipType);
      if (!skipType) {
        walkTypeFields(node.type, walker, skipType);
      }
      return;
    }
    case "intrinsic": {
      walker.string(node.kind);
      walker.string(node.name);
      for (const item14 of node.args) {
        walkExprFields(item14, walker, skipType);
      }
      if (!skipType) {
        walkTypeFields(node.type, walker, skipType);
      }
      return;
    }
    case "jsonStringify": {
      walker.string(node.kind);
      walkExprFields(node.value, walker, skipType);
      if (node.indent !== undefined && node.indent !== null) {
        walker.string(node.indent);
      }
      if (!skipType) {
        walkTypeFields(node.type, walker, skipType);
      }
      return;
    }
    case "libCall": {
      walker.string(node.kind);
      walker.string(node.fn);
      for (const item15 of node.args) {
        walkExprFields(item15, walker, skipType);
      }
      if (!skipType) {
        walkTypeFields(node.type, walker, skipType);
      }
      if (node.assertOptions !== undefined && node.assertOptions !== null) {
        if (node.assertOptions.diff !== undefined && node.assertOptions.diff !== null) {
          walker.string(node.assertOptions.diff);
        }
      }
      return;
    }
    case "logical": {
      walker.string(node.kind);
      walker.string(node.op);
      walkExprFields(node.left, walker, skipType);
      walkExprFields(node.right, walker, skipType);
      if (!skipType) {
        walkTypeFields(node.type, walker, skipType);
      }
      return;
    }
    case "mapIntrinsic": {
      walker.string(node.kind);
      walker.string(node.method);
      walkExprFields(node.receiver, walker, skipType);
      for (const item16 of node.args) {
        walkExprFields(item16, walker, skipType);
      }
      if (!skipType) {
        walkTypeFields(node.type, walker, skipType);
      }
      return;
    }
    case "mapNew": {
      walker.string(node.kind);
      if (node.seed !== undefined && node.seed !== null) {
        for (const item17 of node.seed) {
          walkExprFields(item17.key, walker, skipType);
          walkExprFields(item17.value, walker, skipType);
        }
      }
      if (!skipType) {
        walkTypeFields(node.type, walker, skipType);
      }
      return;
    }
    case "moduleNsRef": {
      walker.string(node.kind);
      walker.string(node.moduleId);
      if (!skipType) {
        walkTypeFields(node.type, walker, skipType);
      }
      return;
    }
    case "new": {
      walker.string(node.kind);
      walker.string(node.className);
      for (const item18 of node.args) {
        walkExprFields(item18, walker, skipType);
      }
      if (!skipType) {
        walkTypeFields(node.type, walker, skipType);
      }
      return;
    }
    case "newPromise": {
      walker.string(node.kind);
      walkExprFields(node.executor, walker, skipType);
      if (!skipType) {
        walkTypeFields(node.type, walker, skipType);
      }
      return;
    }
    case "newValue": {
      walker.string(node.kind);
      walkExprFields(node.callee, walker, skipType);
      for (const item19 of node.args) {
        walkExprFields(item19, walker, skipType);
      }
      if (!skipType) {
        walkTypeFields(node.type, walker, skipType);
      }
      return;
    }
    case "nullish": {
      walker.string(node.kind);
      walkExprFields(node.left, walker, skipType);
      walkExprFields(node.right, walker, skipType);
      if (!skipType) {
        walkTypeFields(node.type, walker, skipType);
      }
      return;
    }
    case "numLit": {
      walker.string(node.kind);
      if (node.spelling !== undefined && node.spelling !== null) {
        walker.string(node.spelling);
      }
      if (!skipType) {
        walkTypeFields(node.type, walker, skipType);
      }
      return;
    }
    case "optChain": {
      walker.string(node.kind);
      walker.string(node.id);
      walkExprFields(node.receiver, walker, skipType);
      walkExprFields(node.body, walker, skipType);
      if (!skipType) {
        walkTypeFields(node.type, walker, skipType);
      }
      return;
    }
    case "orDefault": {
      walker.string(node.kind);
      walkExprFields(node.left, walker, skipType);
      walkExprFields(node.right, walker, skipType);
      if (node.retag !== undefined && node.retag !== null) {
        walker.string(node.retag);
      }
      if (!skipType) {
        walkTypeFields(node.type, walker, skipType);
      }
      return;
    }
    case "promiseVoidWiden": {
      walker.string(node.kind);
      walkExprFields(node.value, walker, skipType);
      if (!skipType) {
        walkTypeFields(node.type, walker, skipType);
      }
      return;
    }
    case "promiseWithResolvers": {
      walker.string(node.kind);
      if (!skipType) {
        walkTypeFields(node.type, walker, skipType);
      }
      return;
    }
    case "recordClone": {
      walker.string(node.kind);
      walkExprFields(node.source, walker, skipType);
      for (const item20 of node.overrides) {
        walker.string(item20.name);
        walkExprFields(item20.value, walker, skipType);
      }
      if (!skipType) {
        walkTypeFields(node.type, walker, skipType);
      }
      return;
    }
    case "recordGet": {
      walker.string(node.kind);
      walkExprFields(node.obj, walker, skipType);
      walker.string(node.shapeId);
      walker.string(node.field);
      if (!skipType) {
        walkTypeFields(node.type, walker, skipType);
      }
      return;
    }
    case "recordHas": {
      walker.string(node.kind);
      walkExprFields(node.obj, walker, skipType);
      walker.string(node.shapeId);
      walker.string(node.field);
      if (!skipType) {
        walkTypeFields(node.type, walker, skipType);
      }
      return;
    }
    case "recordKeyGet": {
      walker.string(node.kind);
      walkExprFields(node.obj, walker, skipType);
      walker.string(node.shapeId);
      walkExprFields(node.key, walker, skipType);
      if (!skipType) {
        walkTypeFields(node.type, walker, skipType);
      }
      return;
    }
    case "recordLit": {
      walker.string(node.kind);
      for (const item21 of node.fields) {
        walker.string(item21.name);
        walkExprFields(item21.value, walker, skipType);
      }
      if (!skipType) {
        walkTypeFields(node.type, walker, skipType);
      }
      return;
    }
    case "recordNullProto": {
      walker.string(node.kind);
      walkExprFields(node.obj, walker, skipType);
      walker.string(node.shapeId);
      if (!skipType) {
        walkTypeFields(node.type, walker, skipType);
      }
      return;
    }
    case "recordOvfHas": {
      walker.string(node.kind);
      walkExprFields(node.obj, walker, skipType);
      walker.string(node.shapeId);
      walkExprFields(node.key, walker, skipType);
      if (!skipType) {
        walkTypeFields(node.type, walker, skipType);
      }
      return;
    }
    case "recordOvfKeys": {
      walker.string(node.kind);
      walkExprFields(node.obj, walker, skipType);
      walker.string(node.shapeId);
      if (!skipType) {
        walkTypeFields(node.type, walker, skipType);
      }
      return;
    }
    case "regexIntrinsic": {
      walker.string(node.kind);
      walker.string(node.method);
      walkExprFields(node.receiver, walker, skipType);
      for (const item22 of node.args) {
        walkExprFields(item22, walker, skipType);
      }
      if (!skipType) {
        walkTypeFields(node.type, walker, skipType);
      }
      return;
    }
    case "regexLit": {
      walker.string(node.kind);
      walker.string(node.pattern);
      walker.string(node.flags);
      if (!skipType) {
        walkTypeFields(node.type, walker, skipType);
      }
      return;
    }
    case "selfRef": {
      walker.string(node.kind);
      if (!skipType) {
        walkTypeFields(node.type, walker, skipType);
      }
      return;
    }
    case "seqExpr": {
      walker.string(node.kind);
      for (const item23 of node.stmts) {
        walkStmtFields(item23, walker, skipType);
      }
      walkExprFields(node.result, walker, skipType);
      if (!skipType) {
        walkTypeFields(node.type, walker, skipType);
      }
      return;
    }
    case "setIntrinsic": {
      walker.string(node.kind);
      walker.string(node.method);
      walkExprFields(node.receiver, walker, skipType);
      for (const item24 of node.args) {
        walkExprFields(item24, walker, skipType);
      }
      if (!skipType) {
        walkTypeFields(node.type, walker, skipType);
      }
      return;
    }
    case "setNew": {
      walker.string(node.kind);
      if (node.seed !== undefined && node.seed !== null) {
        walkExprFields(node.seed, walker, skipType);
      }
      if (!skipType) {
        walkTypeFields(node.type, walker, skipType);
      }
      return;
    }
    case "strCmp": {
      walker.string(node.kind);
      walker.string(node.op);
      walkExprFields(node.left, walker, skipType);
      walkExprFields(node.right, walker, skipType);
      if (!skipType) {
        walkTypeFields(node.type, walker, skipType);
      }
      return;
    }
    case "strConcat": {
      walker.string(node.kind);
      walkExprFields(node.left, walker, skipType);
      walkExprFields(node.right, walker, skipType);
      if (!skipType) {
        walkTypeFields(node.type, walker, skipType);
      }
      return;
    }
    case "strEq": {
      walker.string(node.kind);
      walkExprFields(node.left, walker, skipType);
      walkExprFields(node.right, walker, skipType);
      if (!skipType) {
        walkTypeFields(node.type, walker, skipType);
      }
      return;
    }
    case "strIntrinsic": {
      walker.string(node.kind);
      walker.string(node.method);
      walkExprFields(node.receiver, walker, skipType);
      for (const item25 of node.args) {
        walkExprFields(item25, walker, skipType);
      }
      if (!skipType) {
        walkTypeFields(node.type, walker, skipType);
      }
      return;
    }
    case "strLit": {
      walker.string(node.kind);
      walker.string(node.value);
      if (!skipType) {
        walkTypeFields(node.type, walker, skipType);
      }
      return;
    }
    case "templateStrings": {
      walker.string(node.kind);
      walker.string(node.key);
      for (const item26 of node.cooked) {
        walker.string(item26);
      }
      if (!skipType) {
        walkTypeFields(node.type, walker, skipType);
      }
      return;
    }
    case "ternary": {
      walker.string(node.kind);
      walkExprFields(node.cond, walker, skipType);
      walkExprFields(node.then, walker, skipType);
      walkExprFields(node.else_, walker, skipType);
      if (!skipType) {
        walkTypeFields(node.type, walker, skipType);
      }
      return;
    }
    case "toBool": {
      walker.string(node.kind);
      walkExprFields(node.operand, walker, skipType);
      if (!skipType) {
        walkTypeFields(node.type, walker, skipType);
      }
      return;
    }
    case "toString": {
      walker.string(node.kind);
      walkExprFields(node.operand, walker, skipType);
      if (!skipType) {
        walkTypeFields(node.type, walker, skipType);
      }
      return;
    }
    case "unary": {
      walker.string(node.kind);
      walker.string(node.op);
      walkExprFields(node.operand, walker, skipType);
      if (!skipType) {
        walkTypeFields(node.type, walker, skipType);
      }
      return;
    }
    case "unionDisc": {
      walker.string(node.kind);
      walker.string(node.unionId);
      walker.string(node.field);
      walkExprFields(node.value, walker, skipType);
      if (!skipType) {
        walkTypeFields(node.type, walker, skipType);
      }
      return;
    }
    case "unionEq": {
      walker.string(node.kind);
      walker.string(node.unionId);
      walkExprFields(node.left, walker, skipType);
      walkExprFields(node.right, walker, skipType);
      if (!skipType) {
        walkTypeFields(node.type, walker, skipType);
      }
      return;
    }
    case "unionFuncEq": {
      walker.string(node.kind);
      walker.string(node.unionId);
      walkExprFields(node.union, walker, skipType);
      walkExprFields(node.func, walker, skipType);
      if (!skipType) {
        walkTypeFields(node.type, walker, skipType);
      }
      return;
    }
    case "unionIsTag": {
      walker.string(node.kind);
      walker.string(node.unionId);
      walkExprFields(node.value, walker, skipType);
      if (!skipType) {
        walkTypeFields(node.type, walker, skipType);
      }
      return;
    }
    case "unionKeyGet": {
      walker.string(node.kind);
      walker.string(node.unionId);
      walkExprFields(node.key, walker, skipType);
      walkExprFields(node.value, walker, skipType);
      if (!skipType) {
        walkTypeFields(node.type, walker, skipType);
      }
      return;
    }
    case "unionNarrow": {
      walker.string(node.kind);
      walker.string(node.unionId);
      walkExprFields(node.value, walker, skipType);
      if (!skipType) {
        walkTypeFields(node.type, walker, skipType);
      }
      return;
    }
    case "unionRetype": {
      walker.string(node.kind);
      walker.string(node.fromId);
      walker.string(node.unionId);
      for (const item27 of node.tags) {
      }
      walkExprFields(node.value, walker, skipType);
      if (!skipType) {
        walkTypeFields(node.type, walker, skipType);
      }
      return;
    }
    case "unionWrap": {
      walker.string(node.kind);
      walker.string(node.unionId);
      walkExprFields(node.value, walker, skipType);
      if (!skipType) {
        walkTypeFields(node.type, walker, skipType);
      }
      return;
    }
    case "unitLit": {
      walker.string(node.kind);
      walker.string(node.unit);
      if (!skipType) {
        walkTypeFields(node.type, walker, skipType);
      }
      return;
    }
    case "upcast": {
      walker.string(node.kind);
      walkExprFields(node.value, walker, skipType);
      if (!skipType) {
        walkTypeFields(node.type, walker, skipType);
      }
      return;
    }
    case "varRef": {
      walker.string(node.kind);
      walker.string(node.localId);
      if (!skipType) {
        walkTypeFields(node.type, walker, skipType);
      }
      return;
    }
    case "virtualCall": {
      walker.string(node.kind);
      walker.string(node.className);
      walker.string(node.method);
      for (const item28 of node.args) {
        walkExprFields(item28, walker, skipType);
      }
      if (!skipType) {
        walkTypeFields(node.type, walker, skipType);
      }
      if (node.targets !== undefined && node.targets !== null) {
        for (const item29 of node.targets) {
          walker.string(item29);
        }
      }
      return;
    }
    case "yieldExpr": {
      walker.string(node.kind);
      if (node.value !== undefined && node.value !== null) {
        walkExprFields(node.value, walker, skipType);
      }
      if (node.captureCompletion !== undefined && node.captureCompletion !== null) {
        walkTypeFields(node.captureCompletion.returnType, walker, skipType);
      }
      if (!skipType) {
        walkTypeFields(node.type, walker, skipType);
      }
      return;
    }
  }
}

/** Walks every field of `node` but `loc` (and `type` with `skipType`), and
 * every field of each object under it: the strings and nodes a recursive
 * `for (const key in value)` walk with the same skips finds, read by name in
 * the order ir.ts declares the fields. */
export function walkStmtFields(node: IrStmt, walker: IrFieldWalker, skipType: boolean): void {
  walker.node(node);
  switch (node.kind) {
    case "arrayDelete": {
      walker.string(node.kind);
      walkExprFields(node.arr, walker, skipType);
      walkExprFields(node.index, walker, skipType);
      return;
    }
    case "arraySet": {
      walker.string(node.kind);
      walkExprFields(node.arr, walker, skipType);
      walkExprFields(node.index, walker, skipType);
      walkExprFields(node.value, walker, skipType);
      return;
    }
    case "arraySetLength": {
      walker.string(node.kind);
      walkExprFields(node.arr, walker, skipType);
      walkExprFields(node.length, walker, skipType);
      return;
    }
    case "arraySetUndefined": {
      walker.string(node.kind);
      walkExprFields(node.arr, walker, skipType);
      walkExprFields(node.index, walker, skipType);
      return;
    }
    case "assign": {
      walker.string(node.kind);
      walker.string(node.localId);
      walkExprFields(node.value, walker, skipType);
      return;
    }
    case "block": {
      walker.string(node.kind);
      for (const item30 of node.body) {
        walkStmtFields(item30, walker, skipType);
      }
      if (node.labels !== undefined && node.labels !== null) {
        for (const item31 of node.labels) {
          walker.string(item31);
        }
      }
      return;
    }
    case "break": {
      walker.string(node.kind);
      if (node.label !== undefined && node.label !== null) {
        walker.string(node.label);
      }
      return;
    }
    case "bytesSet": {
      walker.string(node.kind);
      walkExprFields(node.arr, walker, skipType);
      walkExprFields(node.index, walker, skipType);
      walkExprFields(node.value, walker, skipType);
      return;
    }
    case "continue": {
      walker.string(node.kind);
      if (node.label !== undefined && node.label !== null) {
        walker.string(node.label);
      }
      return;
    }
    case "doWhile": {
      walker.string(node.kind);
      for (const item32 of node.body) {
        walkStmtFields(item32, walker, skipType);
      }
      walkExprFields(node.cond, walker, skipType);
      if (node.labels !== undefined && node.labels !== null) {
        for (const item33 of node.labels) {
          walker.string(item33);
        }
      }
      return;
    }
    case "exprStmt": {
      walker.string(node.kind);
      walkExprFields(node.expr, walker, skipType);
      return;
    }
    case "fieldSet": {
      walker.string(node.kind);
      walkExprFields(node.obj, walker, skipType);
      walker.string(node.className);
      walker.string(node.field);
      walkExprFields(node.value, walker, skipType);
      return;
    }
    case "for": {
      walker.string(node.kind);
      if (node.init !== undefined && node.init !== null) {
        walkStmtFields(node.init, walker, skipType);
      }
      if (node.cond !== undefined && node.cond !== null) {
        walkExprFields(node.cond, walker, skipType);
      }
      if (node.update !== undefined && node.update !== null) {
        walkStmtFields(node.update, walker, skipType);
      }
      for (const item34 of node.body) {
        walkStmtFields(item34, walker, skipType);
      }
      if (node.labels !== undefined && node.labels !== null) {
        for (const item35 of node.labels) {
          walker.string(item35);
        }
      }
      return;
    }
    case "forOf": {
      walker.string(node.kind);
      walker.string(node.localId);
      walkExprFields(node.iterable, walker, skipType);
      for (const item36 of node.body) {
        walkStmtFields(item36, walker, skipType);
      }
      if (node.labels !== undefined && node.labels !== null) {
        for (const item37 of node.labels) {
          walker.string(item37);
        }
      }
      return;
    }
    case "if": {
      walker.string(node.kind);
      walkExprFields(node.cond, walker, skipType);
      for (const item38 of node.then) {
        walkStmtFields(item38, walker, skipType);
      }
      if (node.else_ !== undefined && node.else_ !== null) {
        for (const item39 of node.else_) {
          walkStmtFields(item39, walker, skipType);
        }
      }
      return;
    }
    case "recordKeyDelete": {
      walker.string(node.kind);
      walkExprFields(node.obj, walker, skipType);
      walker.string(node.shapeId);
      walkExprFields(node.key, walker, skipType);
      return;
    }
    case "recordKeySet": {
      walker.string(node.kind);
      walkExprFields(node.obj, walker, skipType);
      walker.string(node.shapeId);
      walkExprFields(node.key, walker, skipType);
      walkExprFields(node.value, walker, skipType);
      return;
    }
    case "recordSet": {
      walker.string(node.kind);
      walkExprFields(node.obj, walker, skipType);
      walker.string(node.shapeId);
      walker.string(node.field);
      walkExprFields(node.value, walker, skipType);
      return;
    }
    case "rethrow": {
      walker.string(node.kind);
      walker.string(node.localId);
      return;
    }
    case "return": {
      walker.string(node.kind);
      if (node.value !== undefined && node.value !== null) {
        walkExprFields(node.value, walker, skipType);
      }
      return;
    }
    case "runtimeFence": {
      walker.string(node.kind);
      walker.string(node.code);
      walker.string(node.message);
      return;
    }
    case "switch": {
      walker.string(node.kind);
      walkExprFields(node.disc, walker, skipType);
      for (const item40 of node.cases) {
        if (item40.test !== undefined && item40.test !== null) {
          walkExprFields(item40.test, walker, skipType);
        }
        for (const item41 of item40.body) {
          walkStmtFields(item41, walker, skipType);
        }
      }
      if (node.labels !== undefined && node.labels !== null) {
        for (const item42 of node.labels) {
          walker.string(item42);
        }
      }
      return;
    }
    case "throw": {
      walker.string(node.kind);
      walkExprFields(node.value, walker, skipType);
      return;
    }
    case "tryCatch": {
      walker.string(node.kind);
      for (const item43 of node.tryBody) {
        walkStmtFields(item43, walker, skipType);
      }
      if (node.catchBody !== undefined && node.catchBody !== null) {
        for (const item44 of node.catchBody) {
          walkStmtFields(item44, walker, skipType);
        }
      }
      if (node.catchLocalId !== undefined && node.catchLocalId !== null) {
        walker.string(node.catchLocalId);
      }
      if (node.finallyBody !== undefined && node.finallyBody !== null) {
        for (const item45 of node.finallyBody) {
          walkStmtFields(item45, walker, skipType);
        }
      }
      return;
    }
    case "varDecl": {
      walker.string(node.kind);
      walker.string(node.localId);
      if (node.init !== undefined && node.init !== null) {
        walkExprFields(node.init, walker, skipType);
      }
      return;
    }
    case "while": {
      walker.string(node.kind);
      walkExprFields(node.cond, walker, skipType);
      for (const item46 of node.body) {
        walkStmtFields(item46, walker, skipType);
      }
      if (node.labels !== undefined && node.labels !== null) {
        for (const item47 of node.labels) {
          walker.string(item47);
        }
      }
      return;
    }
  }
}

/** Walks every field of `node` but `loc` (and `type` with `skipType`), and
 * every field of each object under it: the strings and nodes a recursive
 * `for (const key in value)` walk with the same skips finds, read by name in
 * the order ir.ts declares the fields. */
export function walkTypeFields(node: IrType, walker: IrFieldWalker, skipType: boolean): void {
  switch (node.kind) {
    case "array": {
      walker.string(node.kind);
      walkTypeFields(node.elem, walker, skipType);
      return;
    }
    case "bigint": {
      walker.string(node.kind);
      return;
    }
    case "bool": {
      walker.string(node.kind);
      return;
    }
    case "bytes": {
      walker.string(node.kind);
      walker.string(node.elem);
      return;
    }
    case "caught": {
      walker.string(node.kind);
      return;
    }
    case "child": {
      walker.string(node.kind);
      return;
    }
    case "childStream": {
      walker.string(node.kind);
      return;
    }
    case "childWriter": {
      walker.string(node.kind);
      return;
    }
    case "classval": {
      walker.string(node.kind);
      walker.string(node.className);
      return;
    }
    case "cryptoHash": {
      walker.string(node.kind);
      return;
    }
    case "cryptoHmac": {
      walker.string(node.kind);
      return;
    }
    case "date": {
      walker.string(node.kind);
      return;
    }
    case "dgramSocket": {
      walker.string(node.kind);
      return;
    }
    case "dir": {
      walker.string(node.kind);
      return;
    }
    case "dyn": {
      walker.string(node.kind);
      return;
    }
    case "f64": {
      walker.string(node.kind);
      return;
    }
    case "fileHandle": {
      walker.string(node.kind);
      return;
    }
    case "fsWatcher": {
      walker.string(node.kind);
      return;
    }
    case "func": {
      walker.string(node.kind);
      for (const item48 of node.params) {
        walkTypeFields(item48, walker, skipType);
      }
      walkTypeFields(node.ret, walker, skipType);
      if (node.restAbi !== undefined && node.restAbi !== null) {
        walker.string(node.restAbi);
      }
      return;
    }
    case "generator": {
      walker.string(node.kind);
      walkTypeFields(node.yieldT, walker, skipType);
      walkTypeFields(node.retT, walker, skipType);
      walkTypeFields(node.nextT, walker, skipType);
      return;
    }
    case "http2Session": {
      walker.string(node.kind);
      return;
    }
    case "http2Stream": {
      walker.string(node.kind);
      return;
    }
    case "httpClientReq": {
      walker.string(node.kind);
      return;
    }
    case "httpReq": {
      walker.string(node.kind);
      return;
    }
    case "httpRes": {
      walker.string(node.kind);
      return;
    }
    case "jsval": {
      walker.string(node.kind);
      return;
    }
    case "map": {
      walker.string(node.kind);
      walkTypeFields(node.key, walker, skipType);
      walkTypeFields(node.value, walker, skipType);
      return;
    }
    case "moduleNs": {
      walker.string(node.kind);
      walker.string(node.moduleId);
      return;
    }
    case "netServer": {
      walker.string(node.kind);
      return;
    }
    case "netSocket": {
      walker.string(node.kind);
      return;
    }
    case "nullT": {
      walker.string(node.kind);
      return;
    }
    case "object": {
      walker.string(node.kind);
      walker.string(node.className);
      return;
    }
    case "procStream": {
      walker.string(node.kind);
      return;
    }
    case "promise": {
      walker.string(node.kind);
      walkTypeFields(node.inner, walker, skipType);
      return;
    }
    case "record": {
      walker.string(node.kind);
      walker.string(node.shapeId);
      return;
    }
    case "regex": {
      walker.string(node.kind);
      return;
    }
    case "searchParams": {
      walker.string(node.kind);
      return;
    }
    case "secureCtx": {
      walker.string(node.kind);
      return;
    }
    case "set": {
      walker.string(node.kind);
      walkTypeFields(node.elem, walker, skipType);
      return;
    }
    case "spawnRes": {
      walker.string(node.kind);
      return;
    }
    case "stats": {
      walker.string(node.kind);
      return;
    }
    case "string": {
      walker.string(node.kind);
      return;
    }
    case "symbol": {
      walker.string(node.kind);
      return;
    }
    case "testCtx": {
      walker.string(node.kind);
      return;
    }
    case "undefinedT": {
      walker.string(node.kind);
      return;
    }
    case "union": {
      walker.string(node.kind);
      walker.string(node.unionId);
      return;
    }
    case "url": {
      walker.string(node.kind);
      return;
    }
    case "void": {
      walker.string(node.kind);
      return;
    }
  }
}

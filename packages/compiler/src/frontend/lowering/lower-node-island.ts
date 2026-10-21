/* Calls into Node islands. Milestone NI-1 of the scope-B plan has one kind:
 * the explicit @scriptc/node API, `callSync(specifier, name, ...args)` and
 * `call(...)`, which run an export of a module in Node.js loaded into the
 * program (scr_node_island.c, libnode) and copy JSON data both ways. The
 * libCalls are the only `nodeIsland.*` operations, so a program without
 * them links none of that runtime (the `nodeIsland` runtime feature).
 *
 * Semantics, shared with packages/node/index.js (the Node implementation):
 * the arguments are copied with JSON.stringify of the argument array; the
 * module loads with require() from the calling module, so relative
 * specifiers resolve from it; the result crosses as its JSON copy and is
 * checked against the declared result type, like `JSON.parse(s) as T`; a
 * thrown Error crosses as its nearest intrinsic class with its message and
 * string `code`. */
import { realpathSync } from "node:fs";
import * as ts from "../ts7/adapter.js";
import { locOf } from "../program.js";
import type { NodeApiMember } from "../node-api-import.js";
import { type Lowerer } from "./lowerer.js";
import { DYN, STRING, type IrExpr, type IrType } from "../../ir/ir.js";

const JSON_HINT =
  "only JSON data (numbers, strings, booleans, null, arrays, plain objects of those, and unknown) crosses into Node.js in this version";

/** The first part of `t` that is not JSON data, or null. */
function nonJsonPart(lowerer: Lowerer, t: IrType, seen: Set<string>): IrType | null {
  switch (t.kind) {
    case "f64":
    case "string":
    case "bool":
    case "nullT":
    case "undefinedT":
    case "dyn":
      return null;
    case "array":
      return nonJsonPart(lowerer, t.elem, seen);
    case "record": {
      if (seen.has(t.shapeId)) return null;
      seen.add(t.shapeId);
      const shape = lowerer.shapes.get(t.shapeId);
      if (shape === undefined) return t;
      for (const field of shape.fields) {
        const bad = nonJsonPart(lowerer, field.type, seen);
        if (bad !== null) return bad;
      }
      return shape.indexValue === undefined ? null : nonJsonPart(lowerer, shape.indexValue, seen);
    }
    case "union": {
      const def = lowerer.unions.get(t.unionId);
      if (def === undefined) return t;
      for (const arm of def.arms) {
        const bad = nonJsonPart(lowerer, arm, seen);
        if (bad !== null) return bad;
      }
      return null;
    }
    default:
      return t;
  }
}

/** The calling module's real path: relative specifiers resolve from it,
 * as Node's own loader resolves them from the real path of the module. */
function callerPath(node: ts.Node): string {
  const file = ts.getSourceFileOfNode(node).fileName;
  try {
    return realpathSync(file);
  } catch {
    return file;
  }
}

export function lowerNodeApiCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  member: NodeApiMember,
): IrExpr {
  const loc = locOf(call);
  const surface = `${member} (@scriptc/node)`;
  const argNodes = call.arguments.nodes;
  if (call.questionDotToken || argNodes.length < 2 || argNodes.some(ts.isSpreadElement)) {
    lowerer.noLowering(
      `${surface} without a specifier and an export name, or with spread arguments`,
      call,
      "pass the module specifier, the export name and each argument explicitly",
    );
  }
  const specifier = lowerer.lowerExprExpecting(argNodes[0]!, STRING);
  const name = lowerer.lowerExprExpecting(argNodes[1]!, STRING);
  const values = argNodes.slice(2).map((arg) => {
    const value = lowerer.lowerExpr(arg);
    const bad = nonJsonPart(lowerer, value.type, new Set());
    if (bad !== null)
      lowerer.noLowering(`passing '${lowerer.fmt(bad)}' values to ${surface}`, arg, JSON_HINT);
    return lowerer.coerceToExpected(value, DYN);
  });
  const declared = lowerer.mapTypeOf(lowerer.typeOf(call));
  const result = member === "call" && declared?.kind === "promise" ? declared.inner : declared;
  if (declared === null || result === null || result === undefined) {
    lowerer.noLowering(`${surface} with an unrepresentable result type`, call, JSON_HINT);
  }
  if (result.kind !== "void") {
    const bad = nonJsonPart(lowerer, result, new Set());
    if (bad !== null)
      lowerer.noLowering(`'${lowerer.fmt(bad)}' results of ${surface}`, call, JSON_HINT);
  }
  lowerer.usesNodeIsland = true;
  const raw: IrExpr = {
    kind: "libCall",
    fn: member === "call" ? "nodeIsland.call" : "nodeIsland.callSync",
    args: [
      { kind: "strLit", value: callerPath(call), type: STRING, loc },
      specifier,
      name,
      { kind: "dynArrLit", elems: values, type: DYN, loc },
    ],
    type: member === "call" ? { kind: "promise", inner: DYN } : DYN,
    loc,
  };
  // A void result is discarded, unchecked like any void call's value.
  if (declared.kind === "void") return raw;
  // The JSON copy meets the declared type through the checked boundary of
  // `JSON.parse(s) as T`: types don't lie, a mismatch throws.
  return lowerer.coerceToExpected(raw, declared);
}

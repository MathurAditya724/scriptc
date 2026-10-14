import { constructorEscapePoint } from "../cycle-mutability.js";
import {
  VOID,
  type IrClassDef,
  type IrExpr,
  type IrFunction,
  type IrModule,
  type IrRecordShape,
  type IrStmt,
  type IrType,
} from "../../ir/ir.js";
import { everyExpr, everyStmtList, transformStmtList } from "../../ir/traverse.js";

/** Prefix of a function's result-slot entry: `%into.<name>(...params, dst)`
 * writes the function's fresh result object into `dst` and returns nothing. */
export const RESULT_ENTRY_PREFIX = "%into.";

export function resultEntryName(name: string): string {
  return `${RESULT_ENTRY_PREFIX}${name}`;
}

function scalarFields(fields: readonly { type: IrType }[]): boolean {
  return fields.every((field) => field.type.kind === "f64" || field.type.kind === "bool");
}

/** A plain record shape whose fields are numbers and booleans. */
export function scalarRecordShape(shape: IrRecordShape | undefined): boolean {
  return shape !== undefined && !shape.indexValue && !shape.tuple && scalarFields(shape.fields);
}

/** A literal that stores every field of its shape, none of them through
 * the overflow map. */
export function completeRecordLiteral(
  e: IrExpr & { kind: "recordLit" },
  shape: IrRecordShape | undefined,
): boolean {
  if (!shape || e.fields.some((field) => field.overflow)) return false;
  const names = new Set(e.fields.map((field) => field.name));
  return shape.fields.every((field) => names.has(field.name));
}

/** A standalone class with scalar fields whose constructor never lets
 * `this` escape: its instance can be built in caller-provided storage. */
export function scalarStandaloneClass(
  cls: IrClassDef | undefined,
  ctor: IrFunction | undefined,
  isBase: boolean,
  programLifetime: boolean,
): boolean {
  if (
    !cls ||
    !ctor ||
    isBase ||
    programLifetime ||
    cls.runtime ||
    cls.base !== undefined ||
    cls.localCaptures !== undefined ||
    cls.tracksOwnFields ||
    (cls.symbolFields?.length ?? 0) > 0 ||
    ctor.async ||
    ctor.generator ||
    !scalarFields(cls.fields)
  )
    return false;
  const self = ctor.params[0]?.localId;
  return self !== undefined && constructorEscapePoint(ctor, self, null) === ctor.body.length;
}

/** Whether the constructor's top-level statements store every field of
 * `this` before anything reads a field it has not stored yet. Storage for
 * such an instance needs no zeroing first. */
export function constructorInitializesFields(cls: IrClassDef, ctor: IrFunction): boolean {
  const self = ctor.params[0]?.localId;
  if (self === undefined) return false;
  const stored = new Set<string>();
  const unstoredRead = {
    expr: (node: IrExpr): boolean =>
      !(
        node.kind === "fieldGet" &&
        node.obj.kind === "varRef" &&
        node.obj.localId === self &&
        !stored.has(node.field)
      ),
    stmt: () => true,
  };
  for (const stmt of ctor.body) {
    if (stmt.kind === "fieldSet" && stmt.obj.kind === "varRef" && stmt.obj.localId === self) {
      if (!everyExpr(stmt.value, unstoredRead)) return false;
      stored.add(stmt.field);
    } else if (!everyStmtList([stmt], unstoredRead)) return false;
  }
  return cls.fields.every((field) => stored.has(field.name));
}

/** Add a result-slot entry for every function whose returns all build a
 * fresh scalar record or standalone scalar object. The original function
 * stays as it is; the backend calls the entry only where the result is
 * proven to be consumed by projections, passing frame storage. */
export function addRecordResultEntries(mod: IrModule): IrModule {
  const shapes = new Map((mod.records ?? []).map((shape) => [shape.id, shape]));
  const classes = new Map((mod.classes ?? []).map((cls) => [cls.name, cls]));
  const bases = new Set((mod.classes ?? []).flatMap((cls) => (cls.base ? [cls.base] : [])));
  const lifetime = new Set(mod.contracts?.programLifetime ?? []);
  const functions = new Map(mod.functions.map((fn) => [fn.name, fn]));
  const stackClass = (name: string): boolean =>
    scalarStandaloneClass(
      classes.get(name),
      functions.get(`%${name}.constructor`),
      bases.has(name),
      lifetime.has(name),
    );
  const fillable = (value: IrExpr): boolean => {
    switch (value.kind) {
      case "recordLit":
        return completeRecordLiteral(
          value,
          shapes.get((value.type as IrType & { kind: "record" }).shapeId),
        );
      case "new":
        return stackClass(value.className);
      case "ternary":
        return fillable(value.then) && fillable(value.else_);
      default:
        return false;
    }
  };
  const fill = (value: IrExpr, dst: IrExpr): IrStmt[] => {
    switch (value.kind) {
      case "recordLit":
        return value.fields.map((field) => ({
          kind: "recordSet",
          obj: dst,
          shapeId: (value.type as IrType & { kind: "record" }).shapeId,
          field: field.name,
          value: field.value,
          loc: field.value.loc,
        }));
      case "new":
        return [
          {
            kind: "exprStmt",
            expr: {
              kind: "call",
              callee: `%${value.className}.constructor`,
              args: [dst, ...value.args],
              type: VOID,
              loc: value.loc,
            },
            loc: value.loc,
          },
        ];
      case "ternary":
        return [
          {
            kind: "if",
            cond: value.cond,
            then: fill(value.then, dst),
            else_: fill(value.else_, dst),
            loc: value.loc,
          },
        ];
      default:
        throw new Error("unreachable");
    }
  };
  const added: IrFunction[] = [];
  for (const fn of mod.functions) {
    if (fn.async || fn.generator || fn.captures !== undefined || fn.classCaptures !== undefined)
      continue;
    const ret = fn.returnType;
    if (
      !(ret.kind === "record" && scalarRecordShape(shapes.get(ret.shapeId))) &&
      !(ret.kind === "object" && stackClass(ret.className))
    )
      continue;
    let returns = 0;
    const eligible = everyStmtList(fn.body, {
      expr: (e) => e.kind !== "seqExpr",
      stmt: (s) => {
        if (s.kind !== "return") return s.kind !== "tryCatch";
        returns++;
        return s.value !== null && fillable(s.value);
      },
    });
    if (!eligible || returns === 0) continue;
    const dstId = "%into.dst";
    const dst: IrExpr = { kind: "varRef", localId: dstId, type: ret, loc: fn.loc };
    const body = transformStmtList(fn.body, {
      expr: (e) => e,
      stmt: (s) =>
        s.kind === "return" && s.value !== null
          ? { kind: "block", body: [...fill(s.value, dst), { ...s, value: null }], loc: s.loc }
          : s,
    });
    const { sourceName: _sourceName, ownsPrototype: _ownsPrototype, ...rest } = fn;
    added.push({
      ...rest,
      name: resultEntryName(fn.name),
      params: [...fn.params, { localId: dstId, name: "dst", type: ret }],
      locals: [...fn.locals, { id: dstId, name: "dst", type: ret, mutable: false }],
      returnType: VOID,
      body,
    });
  }
  return added.length === 0 ? mod : { ...mod, functions: [...mod.functions, ...added] };
}

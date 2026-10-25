import {
  F64,
  isRefCounted,
  type IrExpr,
  type IrFunction,
  type IrLocal,
  type IrModule,
  type IrRecordShape,
  type IrStmt,
} from "./ir.js";
import {
  everyExpr,
  everyExprChild,
  everyStmtChild,
  everyStmtList,
  transformStmtList,
} from "./traverse.js";

const MAX_FIELDS = 4;
const MAX_CALLEE_NODES = 256;
const MAX_INLINE_NODES = 1024;

interface Producer {
  fn: IrFunction;
  shape: IrRecordShape;
  size: number;
}

/** Splitting an expression frame must not shorten a reference temporary's
 * lifetime across later arguments, fields, or the original call itself. */
function scalarTemporaries(value: IrExpr): boolean {
  return everyExpr(value, { expr: (expr) => !isRefCounted(expr.type), stmt: () => true });
}

function producer(fn: IrFunction, shapes: ReadonlyMap<string, IrRecordShape>): Producer | null {
  if (
    fn.async ||
    fn.generator ||
    fn.captures?.length ||
    fn.classCaptures?.length ||
    fn.returnType.kind !== "record"
  )
    return null;
  const shape = shapes.get(fn.returnType.shapeId);
  if (
    !shape ||
    shape.tuple ||
    shape.indexValue ||
    shape.fields.length === 0 ||
    shape.fields.length > MAX_FIELDS ||
    shape.fields.some((f) => f.type.kind !== "f64")
  )
    return null;
  // Scalar parameters/locals need no ownership cleanup across the inlined
  // return. Closures, suspension and finally completions remain out of scope.
  if (
    fn.locals.some((l) => l.boxed || l.tdz || (l.type.kind !== "f64" && l.type.kind !== "bool")) ||
    fn.params.some((p) => p.type.kind !== "f64" && p.type.kind !== "bool")
  )
    return null;
  let size = 0;
  let returns = 0;
  const eligible = everyStmtList(fn.body, {
    expr: (expr) => {
      if (++size > MAX_CALLEE_NODES) return false;
      switch (expr.kind) {
        case "closure":
        case "selfRef":
        case "awaitExpr":
        case "awaitUnionExpr":
        case "yieldExpr":
          return false;
        default:
          return true;
      }
    },
    stmt: (stmt) => {
      if (++size > MAX_CALLEE_NODES || stmt.kind === "tryCatch") return false;
      if (stmt.kind !== "return") return true;
      returns++;
      const value = stmt.value;
      return (
        value?.kind === "recordLit" &&
        value.type.kind === "record" &&
        value.type.shapeId === shape.id &&
        value.fields.length === shape.fields.length &&
        value.fields.every(
          (f) =>
            !f.overflow &&
            f.value.type.kind === "f64" &&
            scalarTemporaries(f.value) &&
            shape.fields.some((sf) => sf.name === f.name),
        )
      );
    },
  });
  return eligible && returns > 0 ? { fn, shape, size } : null;
}

/** A result may only be read through its declared scalar fields. Even an
 * apparently harmless alias, identity test, mutation or closure capture
 * keeps the original object. Count declarations too: no reinitialization. */
function fieldOnlyUses(fn: IrFunction, localId: string, shape: IrRecordShape): boolean {
  let declarations = 0;
  function expr(node: IrExpr): boolean {
    if (node.kind === "recordGet" && node.obj.kind === "varRef" && node.obj.localId === localId) {
      return (
        node.shapeId === shape.id &&
        node.type.kind === "f64" &&
        shape.fields.some((f) => f.name === node.field)
      );
    }
    switch (node.kind) {
      case "varRef":
      case "incDec":
      case "assignExpr":
        if (node.localId === localId) return false;
        break;
      case "closure":
      case "classRef":
        if (node.captures?.includes(localId)) return false;
        break;
    }
    return everyExprChild(node, expr, stmt);
  }
  function stmt(node: IrStmt): boolean {
    switch (node.kind) {
      case "varDecl":
        if (node.localId === localId && ++declarations !== 1) return false;
        break;
      case "assign":
      case "forOf":
      case "rethrow":
        if (node.localId === localId) return false;
        break;
    }
    return everyStmtChild(node, expr, stmt);
  }
  return fn.body.every(stmt) && declarations === 1;
}

/** Label ids participate in the same fresh-name namespace as local ids. */
function collectLabels(body: IrStmt[], used: Set<string>): void {
  everyStmtList(body, {
    expr: () => true,
    stmt: (node) => {
      switch (node.kind) {
        case "while":
        case "doWhile":
        case "for":
        case "forOf":
        case "switch":
        case "block":
          for (const label of node.labels ?? []) used.add(label);
          break;
      }
      return true;
    },
  });
}

interface Replacement {
  fields: Map<string, string>;
  body: IrStmt[];
}

/** Eliminate small fresh numeric result records at direct, field-only call
 * sites. This is a bounded shared backend pass, not a change to record ABI:
 * the original producer remains available to all other callers. Arguments
 * and literal fields retain source evaluation order. A labeled block models
 * return, including returns inside loops, without changing caller control
 * flow. Unknown uses and non-scalar producer locals keep the heap path. */
export function scalarizeNumericRecords(mod: IrModule): IrModule {
  const shapes = new Map((mod.records ?? []).map((s) => [s.id, s]));
  const producers = new Map<string, Producer>();
  for (const fn of mod.functions) {
    const p = producer(fn, shapes);
    if (p) producers.set(fn.name, p);
  }
  if (producers.size === 0) return mod;
  let changed = false;
  const functions = mod.functions.map((fn): IrFunction => {
    if (fn.async || fn.generator) return fn;
    const locals = new Map(fn.locals.map((l) => [l.id, l]));
    const used = new Set([...locals.keys(), ...(mod.globals ?? []).map((g) => g.id)]);
    collectLabels(fn.body, used);
    // A header accepts one statement, not an inlined block. Local ids are
    // unique within a function and fieldOnlyUses proves one declaration.
    const loopHeaders = new Set<string>();
    everyStmtList(fn.body, {
      expr: () => true,
      stmt: (node) => {
        if (node.kind === "for") {
          if (node.init?.kind === "varDecl") loopHeaders.add(node.init.localId);
          if (node.update?.kind === "varDecl") loopHeaders.add(node.update.localId);
        }
        return true;
      },
    });
    let next = 0;
    const fresh = (): string => {
      let id: string;
      do {
        id = `%scalar.${next++}`;
      } while (used.has(id));
      used.add(id);
      return id;
    };
    const added: IrLocal[] = [];
    const replacements = new Map<string, Replacement>();
    let budget = MAX_INLINE_NODES;
    everyStmtList(fn.body, {
      expr: () => true,
      stmt: (decl) => {
        if (decl.kind !== "varDecl" || loopHeaders.has(decl.localId)) return true;
        const local = locals.get(decl.localId);
        const call = decl.init;
        if (
          !local ||
          local.mutable ||
          local.boxed ||
          local.tdz ||
          local.type.kind !== "record" ||
          call?.kind !== "call"
        )
          return true;
        const p = producers.get(call.callee);
        if (
          !p ||
          p.fn.name === fn.name ||
          p.size > budget ||
          p.shape.id !== local.type.shapeId ||
          call.args.length !== p.fn.params.length ||
          !call.args.every(scalarTemporaries) ||
          !fieldOnlyUses(fn, local.id, p.shape)
        )
          return true;
        budget -= p.size;
        for (const l of p.fn.locals) used.add(l.id);
        collectLabels(p.fn.body, used);
        const fields = new Map(p.shape.fields.map((f) => [f.name, fresh()]));
        const renamed = new Map(p.fn.locals.map((l) => [l.id, fresh()]));
        const labels = new Map<string, string>();
        const exit = fresh();
        const label = (name: string): string => {
          if (!labels.has(name)) labels.set(name, fresh());
          return labels.get(name)!;
        };
        for (const f of p.shape.fields)
          added.push({
            id: fields.get(f.name)!,
            name: `${local.name}.${f.name}`,
            type: F64,
            mutable: true,
          });
        for (const l of p.fn.locals) added.push({ ...l!, id: renamed.get(l.id)! });
        const body = transformStmtList(p.fn.body, {
          expr: (expr) => {
            switch (expr.kind) {
              case "varRef":
                return { ...expr, localId: renamed.get(expr.localId) ?? expr.localId };
              case "incDec":
                return { ...expr, localId: renamed.get(expr.localId) ?? expr.localId };
              case "assignExpr":
                return { ...expr, localId: renamed.get(expr.localId) ?? expr.localId };
              default:
                return expr;
            }
          },
          stmt: (stmt): IrStmt => {
            switch (stmt.kind) {
              case "return": {
                const literal = stmt.value;
                if (literal?.kind !== "recordLit") return stmt; // producer proved this shape
                const assignments: IrStmt[] = literal.fields.map((f): IrStmt => ({
                  kind: "assign",
                  localId: fields.get(f.name)!,
                  value: f.value,
                  loc: stmt.loc,
                }));
                return {
                  kind: "block",
                  body: [...assignments, { kind: "break", label: exit, loc: stmt.loc }],
                  loc: stmt.loc,
                };
              }
              case "varDecl":
                return { ...stmt, localId: renamed.get(stmt.localId) ?? stmt.localId };
              case "assign":
                return { ...stmt, localId: renamed.get(stmt.localId) ?? stmt.localId };
              case "forOf":
                return stmt.labels
                  ? {
                      ...stmt,
                      localId: renamed.get(stmt.localId) ?? stmt.localId,
                      labels: stmt.labels.map(label),
                    }
                  : { ...stmt, localId: renamed.get(stmt.localId) ?? stmt.localId };
              case "break":
                return stmt.label && stmt.label !== exit
                  ? { ...stmt, label: label(stmt.label) }
                  : stmt;
              case "continue":
                return stmt.label ? { ...stmt, label: label(stmt.label) } : stmt;
              case "while":
                return stmt.labels ? { ...stmt, labels: stmt.labels.map(label) } : stmt;
              case "doWhile":
                return stmt.labels ? { ...stmt, labels: stmt.labels.map(label) } : stmt;
              case "for":
                return stmt.labels ? { ...stmt, labels: stmt.labels.map(label) } : stmt;
              case "switch":
                return stmt.labels ? { ...stmt, labels: stmt.labels.map(label) } : stmt;
              case "block":
                return stmt.labels ? { ...stmt, labels: stmt.labels.map(label) } : stmt;
              default:
                return stmt;
            }
          },
        });
        const parameters: IrStmt[] = p.fn.params.map((param, i): IrStmt => ({
          kind: "varDecl",
          localId: renamed.get(param.localId)!,
          init: call.args[i]!,
          loc: decl.loc,
        }));
        const declarations: IrStmt[] = [...fields.values()].map((id): IrStmt => ({
          kind: "varDecl",
          localId: id!,
          init: null,
          loc: decl.loc,
        }));
        replacements.set(local.id, {
          fields,
          body: [
            ...declarations,
            { kind: "block", labels: [exit], body: [...parameters, ...body], loc: decl.loc },
          ],
        });
        return true;
      },
    });
    if (replacements.size === 0) return fn;
    changed = true;
    const body = transformStmtList(fn.body, {
      stmt: (stmt) => {
        const replacement = stmt.kind === "varDecl" ? replacements.get(stmt.localId) : undefined;
        return replacement ? { kind: "block", body: replacement.body, loc: stmt.loc } : stmt;
      },
      expr: (expr) => {
        if (expr.kind === "recordGet" && expr.obj.kind === "varRef") {
          const id = replacements.get(expr.obj.localId)?.fields.get(expr.field);
          if (id) return { kind: "varRef", localId: id, type: F64, loc: expr.loc };
        }
        return expr;
      },
    });
    return {
      ...fn!,
      locals: [...fn.locals.filter((l) => !replacements.has(l.id)), ...added],
      body,
    };
  });
  return changed ? { ...mod, functions } : mod;
}

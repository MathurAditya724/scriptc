import { expect, test } from "vitest";
import { BOOL, F64, VOID, type IrExpr, type IrFunction, type IrModule, type IrStmt } from "./ir.js";
import { everyStmtList } from "./traverse.js";
import { jamSaturatingLoops } from "./saturating-loop-jams.js";

const loc = { file: "saturating-loop-jams.ts", start: 0, end: 0 };
const BYTES = { kind: "bytes", elem: "f64" } as const;
const num = (value: number): IrExpr => ({ loc, kind: "numLit", value, type: F64 });
const ref = (localId: string): IrExpr => ({ loc, kind: "varRef", localId, type: F64 });
type Op = "+" | "*" | "-" | "<" | ">" | "|" | "===" | "<<";
const bin = (op: Op, left: IrExpr, right: IrExpr): IrExpr => ({
  loc,
  kind: "bin",
  op,
  left,
  right,
  type: op === "<" || op === ">" || op === "===" ? BOOL : F64,
});
const decl = (id: string, init: IrExpr): IrStmt => ({ loc, kind: "varDecl", localId: id, init });
const set = (id: string, value: IrExpr): IrStmt => ({ loc, kind: "assign", localId: id, value });
const stepBy = (id: string, by: number): IrStmt => set(id, bin("+", ref(id), num(by)));
const loop = (id: string, end: IrExpr, by: number, body: IrStmt[]): IrStmt & { kind: "for" } => ({
  loc,
  kind: "for",
  init: decl(id, num(0)),
  cond: bin("<", ref(id), end),
  update: stepBy(id, by),
  body,
});
const exitWhen = (acc: string, full: number): IrStmt => ({
  loc,
  kind: "if",
  cond: bin("===", ref(acc), num(full)),
  then: [{ loc, kind: "break" }],
  else_: null,
});
const get = (index: IrExpr): IrExpr => ({
  loc,
  kind: "bytesIntrinsic",
  method: "get",
  receiver: { loc, kind: "varRef", localId: "cr", type: BYTES },
  args: [index],
  type: F64,
  invalidNaN: true,
});

/** One lane of mandelbrot's escape test: `z = z * z + c`, `b |= bit` and
 * an exit once `b` is full. */
function lane(z: string, c: string, bit: number, full = 3, extra: IrStmt[] = []): IrStmt[] {
  return [
    decl(`${z}.t`, bin("*", ref(z), ref(z))),
    set(z, bin("+", ref(`${z}.t`), ref(c))),
    {
      loc,
      kind: "if",
      cond: bin(">", ref(`${z}.t`), num(4)),
      then: [set("b", bin("|", ref("b"), num(bit))), exitWhen("b", full), ...extra],
      else_: null,
    },
  ];
}

function nest(
  options: { full?: number; post?: IrStmt[]; preExtra?: IrStmt[]; copies?: number } = {},
): IrStmt[] {
  const post = options.post ?? [set("res", bin("|", bin("<<", ref("res"), num(2)), ref("b")))];
  return [
    decl("res", num(0)),
    loop("i", num(2 * (options.copies ?? 4)), 2, [
      decl("c1", get(ref("i"))),
      decl("c2", get(bin("+", ref("i"), num(1)))),
      decl("z1", ref("c1")),
      decl("z2", ref("c2")),
      decl("b", num(0)),
      ...(options.preExtra ?? []),
      loop("j", num(50), 1, [
        ...lane("z1", "c1", 2, options.full),
        ...lane("z2", "c2", 1, options.full),
      ]),
      ...post,
    ]),
  ];
}

function moduleOf(body: IrStmt[]): IrModule {
  const ids = new Set<string>();
  everyStmtList(body, {
    expr: (e) => {
      if (e.kind === "varRef" && e.localId !== "cr") ids.add(e.localId);
      return true;
    },
    stmt: (s) => {
      if (s.kind === "varDecl" || s.kind === "assign") ids.add(s.localId);
      return true;
    },
  });
  const fn: IrFunction = {
    name: "render",
    params: [{ localId: "cr", name: "cr", type: BYTES }],
    locals: [
      { id: "cr", name: "cr", type: BYTES, mutable: false },
      ...[...ids].map((id) => ({ id, name: id, type: F64, mutable: true })),
    ],
    body,
    returnType: VOID,
    loc,
  };
  return { irVersion: 17, sourceFile: loc.file, entry: "render", functions: [fn] } as IrModule;
}

function loops(body: IrStmt[]): (IrStmt & { kind: "for" })[] {
  const found: (IrStmt & { kind: "for" })[] = [];
  everyStmtList(body, {
    expr: () => true,
    stmt: (s) => {
      if (s.kind === "for") found.push(s);
      return true;
    },
  });
  return found;
}

test("jams a constant-count loop whose inner loop exits once its accumulator is full", () => {
  const mod = moduleOf(nest());
  const out = jamSaturatingLoops(mod);
  expect(out).not.toBe(mod);
  const body = out.functions[0]!.body;
  // The outer loop is gone: one inner loop runs the four iterations.
  const remaining = loops(body);
  expect(remaining.length).toBe(1);
  const inner = remaining[0]!;
  // Its only exit tests every copy's accumulator, at the end of the body.
  let breaks = 0;
  everyStmtList(inner.body, {
    expr: () => true,
    stmt: (s) => {
      if (s.kind === "break") breaks++;
      return true;
    },
  });
  expect(breaks).toBe(1);
  const last = inner.body[inner.body.length - 1]!;
  expect(last.kind).toBe("if");
  // Each copy keeps its own accumulator and lanes; `post` runs in order.
  const added = out.functions[0]!.locals.filter((local) => local.id.startsWith("%jam."));
  expect(added.filter((local) => local.name === "%jam.b").length).toBe(4);
  const block = body[1]!;
  expect(block.kind).toBe("block");
  if (block.kind !== "block") return;
  const posts = block.body.slice(-4);
  expect(posts.every((s) => s.kind === "assign" && s.localId === "res")).toBe(true);
});

test("keeps loops whose exits or values do not allow running iterations together", () => {
  const reject = (body: IrStmt[]): void => {
    const mod = moduleOf(body);
    expect(jamSaturatingLoops(mod)).toBe(mod);
  };
  // An exit before the accumulator is full: later ORs would change it.
  reject(nest({ full: 2 }));
  // `post` reads a lane value the copies keep computing past their exit.
  reject(nest({ post: [set("res", bin("+", ref("res"), ref("z1")))] }));
  // `pre` reads what `post` writes.
  reject(nest({ preExtra: [decl("seed", ref("res"))] }));
  // One iteration, or more than eight.
  reject(nest({ copies: 1 }));
  reject(nest({ copies: 9 }));
  // A store in the inner loop is observable past an exit.
  reject([
    decl("res", num(0)),
    loop("i", num(8), 2, [
      decl("b", num(0)),
      decl("z1", num(0)),
      loop("j", num(50), 1, [
        ...lane("z1", "z1", 2, 3, [
          {
            loc,
            kind: "bytesSet",
            arr: { loc, kind: "varRef", localId: "cr", type: BYTES },
            index: num(0),
            value: num(1),
          },
        ]),
      ]),
      set("res", bin("|", ref("res"), ref("b"))),
    ]),
  ]);
});

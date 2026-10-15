import type { IrExpr, IrFunction, IrLocal, IrModule, IrStmt, IrType } from "../../ir/ir.js";
import { mangleFunction } from "../mangle.js";
import { BlockBuilder } from "./blocks.js";

/** Speculative integer clones of pure number-valued functions.
 *
 * A function qualifies when its parameters, locals and result are numbers
 * or booleans and its body only reads and writes its own locals, branches,
 * computes with numbers and booleans, and directly calls other qualifying
 * functions. Such a body has no observable effect besides its result, a
 * stack-overflow RangeError, or not terminating.
 *
 * Its clone (`<symbol>.int`) takes its number parameters as i32 and keeps
 * every number in the int32 range: literals are int32, `+ - * % -x` are
 * overflow checked (a result that leaves the int32 range or is -0 bails
 * out), and bitwise operators are exact. While nothing bails, every value
 * equals the double the ordinary body computes, so the clone's result is
 * the ordinary result. The clone returns CLONE_RESULT: the int32 (a
 * boolean zero-extended) and a bail flag, in two registers, so a caller
 * tests one flag and no out-of-band constant occupies a register. A caller
 * inside a clone tests a call result before its first use and forwards
 * BAIL to its own caller; a call result it returns as is passes through
 * untested.
 *
 * Recursive members also get a dispatcher (`<entry>.spec`, with the ABI
 * of the entry direct calls use) for callers outside their recursion: it
 * runs the clone when every number argument is exactly an int32 (bit-equal,
 * so never -0, NaN, a fraction or out of range) and otherwise, or after a
 * bail, the ordinary body from the start. Rerunning is sound because the
 * clone had no effect. Calls inside the recursion's ordinary bodies keep
 * the ordinary entries, so one bail costs at most one more full run.
 *
 * The clone checks the stack guard like the ordinary body. On overflow it
 * leaves Node's RangeError pending and bails; the dispatcher
 * forwards a pending exception instead of rerunning. No other exception
 * can arise, so calls between clones need no pending test.
 *
 * Self tail calls (`return f(...)`) and accumulating self calls (`return
 * x + f(...)`, also `f(...) + x` when `x` calls nothing) become a loop.
 * The loop counts its iterations and bails beyond TAIL_LIMIT, so recursion
 * that would overflow the stack (or never end) reruns as ordinary
 * recursion and throws there. Its int32 accumulator is overflow checked.
 * That is exact: with every partial sum and the final result in the int32
 * range, every value the ordinary body adds is the final result minus a
 * partial sum, within 2^32, so each double addition is exact. */
export interface IntegerClones {
  /** Functions with an integer clone. */
  readonly members: ReadonlySet<string>;
  /** Members with a dispatcher: those in a recursive call cycle. */
  readonly dispatched: ReadonlySet<string>;
  /** The recursive component of each dispatched member. */
  readonly component: ReadonlyMap<string, number>;
}

export const NO_INTEGER_CLONES: IntegerClones = {
  members: new Set(),
  dispatched: new Set(),
  component: new Map(),
};

/** A clone's result: the value and whether the clone bailed. */
export const CLONE_RESULT = "{ i32, i1 }";
/** The result of a clone that bailed: no caller reads its value. */
const BAIL = `${CLONE_RESULT} { i32 poison, i1 true }`;
/** Self tail-call iterations one clone frame runs before it bails (2^14). */
const TAIL_LIMIT = 16384;

/** The single-threaded stack guard, declared as the emitter's ordinary
 * stack checks declare it (clones only exist without workers). */
export const STACK_GUARD_DECL = "@scr_stack_guard = external global ptr";

export const INTEGER_CLONE_SUFFIX = ".int";
export const INTEGER_DISPATCH_SUFFIX = ".spec";

type Scalar = "num" | "bool";

function scalarKind(type: IrType): Scalar | null {
  return type.kind === "f64" ? "num" : type.kind === "bool" ? "bool" : null;
}

function isInt32Literal(value: number): boolean {
  return (
    Number.isInteger(value) && value >= -0x80000000 && value <= 0x7fffffff && !Object.is(value, -0)
  );
}

/** The call targets of `fn` when its body has the qualifying shape. */
function cloneShape(fn: IrFunction): Set<string> | null {
  if (fn.async || fn.generator !== undefined || fn.captures !== undefined) return null;
  if (fn.classCaptures !== undefined && fn.classCaptures.length > 0) return null;
  const result = scalarKind(fn.returnType);
  if (result === null) return null;
  const locals = new Map<string, IrLocal>(fn.locals.map((l) => [l.id, l]));
  const localKind = (id: string): Scalar | null => {
    const local = locals.get(id);
    if (!local || local.boxed || local.tdz) return null;
    return scalarKind(local.type);
  };
  for (const p of fn.params)
    if (localKind(p.localId) === null || scalarKind(p.type) === null) return null;
  const callees = new Set<string>();
  const expr = (e: IrExpr, want: Scalar): boolean => {
    if (scalarKind(e.type) !== want) return false;
    switch (e.kind) {
      case "numLit":
        return isInt32Literal(e.value);
      case "boolLit":
        return true;
      case "varRef":
        return localKind(e.localId) === want;
      case "bin":
        switch (e.op) {
          case "+":
          case "-":
          case "*":
          case "%":
          case "&":
          case "|":
          case "^":
          case "<<":
          case ">>":
          case ">>>":
            return want === "num" && expr(e.left, "num") && expr(e.right, "num");
          case "<":
          case "<=":
          case ">":
          case ">=":
            return want === "bool" && expr(e.left, "num") && expr(e.right, "num");
          case "===":
          case "!==": {
            if (want !== "bool") return false;
            const operand = scalarKind(e.left.type);
            return operand !== null && expr(e.left, operand) && expr(e.right, operand);
          }
          default:
            return false;
        }
      case "unary":
        return e.op === "!"
          ? want === "bool" && expr(e.operand, "bool")
          : want === "num" && expr(e.operand, "num");
      case "toBool": {
        const operand = scalarKind(e.operand.type);
        return want === "bool" && operand !== null && expr(e.operand, operand);
      }
      case "logical":
        return want === "bool" && expr(e.left, "bool") && expr(e.right, "bool");
      case "ternary":
        return expr(e.cond, "bool") && expr(e.then, want) && expr(e.else_, want);
      case "call":
        callees.add(e.callee);
        return e.args.every((a) => {
          const kind = scalarKind(a.type);
          return kind !== null && expr(a, kind);
        });
      default:
        return false;
    }
  };
  const stmts = (list: readonly IrStmt[]): boolean => list.every(stmt);
  const stmt = (s: IrStmt): boolean => {
    switch (s.kind) {
      case "return":
        return s.value !== null && s.awaited !== true && expr(s.value, result);
      case "if":
        return expr(s.cond, "bool") && stmts(s.then) && (s.else_ === null || stmts(s.else_));
      case "block":
        return (s.labels === undefined || s.labels.length === 0) && stmts(s.body);
      case "varDecl": {
        const kind = localKind(s.localId);
        return kind !== null && s.init !== null && expr(s.init, kind);
      }
      case "assign": {
        const kind = localKind(s.localId);
        return kind !== null && expr(s.value, kind);
      }
      case "exprStmt": {
        const kind = scalarKind(s.expr.type);
        return kind !== null && expr(s.expr, kind);
      }
      default:
        return false;
    }
  };
  return stmts(fn.body) ? callees : null;
}

/** Every call in `fn`'s body has arguments of its callee's parameter kinds. */
function callsMatch(fn: IrFunction, byName: ReadonlyMap<string, IrFunction>): boolean {
  let ok = true;
  const visit = (e: IrExpr): void => {
    switch (e.kind) {
      case "call": {
        const callee = byName.get(e.callee);
        if (
          !callee ||
          callee.params.length !== e.args.length ||
          scalarKind(callee.returnType) !== scalarKind(e.type) ||
          callee.params.some((p, i) => scalarKind(p.type) !== scalarKind(e.args[i]!.type))
        )
          ok = false;
        e.args.forEach(visit);
        return;
      }
      case "bin":
      case "logical":
        visit(e.left);
        visit(e.right);
        return;
      case "unary":
      case "toBool":
        visit(e.operand);
        return;
      case "ternary":
        visit(e.cond);
        visit(e.then);
        visit(e.else_);
        return;
      default:
        return;
    }
  };
  const stmts = (list: readonly IrStmt[]): void => {
    for (const s of list) {
      if (s.kind === "return" && s.value) visit(s.value);
      else if (s.kind === "if") {
        visit(s.cond);
        stmts(s.then);
        if (s.else_) stmts(s.else_);
      } else if (s.kind === "block") stmts(s.body);
      else if (s.kind === "varDecl" && s.init) visit(s.init);
      else if (s.kind === "assign") visit(s.value);
      else if (s.kind === "exprStmt") visit(s.expr);
    }
  };
  stmts(fn.body);
  return ok;
}

export function findIntegerClones(mod: IrModule): IntegerClones {
  const byName = new Map(mod.functions.map((fn) => [fn.name, fn]));
  const edges = new Map<string, Set<string>>();
  for (const fn of mod.functions) {
    const callees = cloneShape(fn);
    if (callees && callsMatch(fn, byName)) edges.set(fn.name, callees);
  }
  // Drop functions that call a non-member until none does.
  for (let changed = true; changed;) {
    changed = false;
    for (const [name, callees] of edges)
      for (const callee of callees)
        if (!edges.has(callee)) {
          edges.delete(name);
          changed = true;
          break;
        }
  }
  if (edges.size === 0) return NO_INTEGER_CLONES;
  // Tarjan's strongly connected components over the member call graph.
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const component = new Map<string, number>();
  const dispatched = new Set<string>();
  let counter = 0;
  let components = 0;
  const strong = (name: string): void => {
    index.set(name, counter);
    low.set(name, counter++);
    stack.push(name);
    onStack.add(name);
    for (const callee of edges.get(name)!) {
      if (!index.has(callee)) {
        strong(callee);
        low.set(name, Math.min(low.get(name)!, low.get(callee)!));
      } else if (onStack.has(callee)) low.set(name, Math.min(low.get(name)!, index.get(callee)!));
    }
    if (low.get(name) !== index.get(name)) return;
    const members: string[] = [];
    for (;;) {
      const top = stack.pop()!;
      onStack.delete(top);
      members.push(top);
      if (top === name) break;
    }
    const id = components++;
    if (members.length > 1 || edges.get(name)!.has(name))
      for (const member of members) {
        dispatched.add(member);
        component.set(member, id);
      }
  };
  for (const name of edges.keys()) if (!index.has(name)) strong(name);
  return { members: new Set(edges.keys()), dispatched, component };
}

/** Whether a direct call from `caller` to `callee` enters the callee's
 * dispatcher: callers inside the callee's recursion run its ordinary body
 * (they are the fallback). */
export function dispatchesCall(clones: IntegerClones, caller: string, callee: string): boolean {
  if (!clones.dispatched.has(callee)) return false;
  const own = clones.component.get(caller);
  return own === undefined || own !== clones.component.get(callee);
}

export interface IntegerCloneHost {
  declare(decl: string): void;
  /** Lines setting the i1 `dest` to "an exception is pending". */
  pendingTestLines(dest: string): string[];
}

interface NumValue {
  name: string;
  /** A CLONE_RESULT that may have bailed (a clone call result); otherwise
   * an int32 i32. */
  wide: boolean;
}

/** Calls in `e` (an expression that calls nothing is free to evaluate early). */
function callsAnything(e: IrExpr): boolean {
  switch (e.kind) {
    case "call":
      return true;
    case "bin":
    case "logical":
      return callsAnything(e.left) || callsAnything(e.right);
    case "unary":
    case "toBool":
      return callsAnything(e.operand);
    case "ternary":
      return callsAnything(e.cond) || callsAnything(e.then) || callsAnything(e.else_);
    default:
      return false;
  }
}

/** Whether emitNum answers an untested CLONE_RESULT for `e`. */
function mayBail(e: IrExpr): boolean {
  if (e.kind === "call") return true;
  return e.kind === "ternary" && (mayBail(e.then) || mayBail(e.else_));
}

/** One activation of the body: the clone's own, or a self call inlined
 * into it. */
interface Frame {
  slots: Map<string, { slot: string; kind: Scalar }>;
  loopLabel: string | null;
  accSlot: string | null;
  depthSlot: string | null;
  /** An inlined activation delivers its result here instead of returning. */
  inline: { result: string; done: string } | null;
}

/** IR nodes of `e`. */
function exprSize(e: IrExpr): number {
  switch (e.kind) {
    case "bin":
    case "logical":
      return 1 + exprSize(e.left) + exprSize(e.right);
    case "unary":
    case "toBool":
      return 1 + exprSize(e.operand);
    case "ternary":
      return 1 + exprSize(e.cond) + exprSize(e.then) + exprSize(e.else_);
    case "call":
      return 1 + e.args.reduce((n, a) => n + exprSize(a), 0);
    default:
      return 1;
  }
}

function stmtsSize(list: readonly IrStmt[]): number {
  let n = 0;
  for (const s of list) {
    n += 1;
    if (s.kind === "return" && s.value) n += exprSize(s.value);
    else if (s.kind === "if") n += exprSize(s.cond) + stmtsSize(s.then) + stmtsSize(s.else_ ?? []);
    else if (s.kind === "block") n += stmtsSize(s.body);
    else if (s.kind === "varDecl" && s.init) n += exprSize(s.init);
    else if (s.kind === "assign") n += exprSize(s.value);
    else if (s.kind === "exprStmt") n += exprSize(s.expr);
  }
  return n;
}

/** IR nodes the inlined copies of a body's self calls may add. */
const INLINE_BUDGET = 160;

class CloneEmitter {
  private readonly B = new BlockBuilder();
  private readonly result: Scalar;
  private bailLabel: string | null = null;
  private frame!: Frame;
  private slotCount = 0;
  /** Inline one level of non-tail self calls: each removes the call, the
   * stack check and the frame of a recursion level (leaf calls entirely). */
  private readonly inlineSelf: boolean;

  constructor(
    private readonly fn: IrFunction,
    private readonly host: IntegerCloneHost,
    private readonly stackCheck: boolean,
  ) {
    this.result = scalarKind(fn.returnType)!;
    const size = stmtsSize(fn.body);
    this.inlineSelf = size * this.selfCallSites() <= INLINE_BUDGET;
  }

  /** Self calls the body makes outside its tail positions. */
  private selfCallSites(): number {
    let all = 0;
    const count = (e: IrExpr): void => {
      if (this.isSelfCall(e)) all++;
      switch (e.kind) {
        case "bin":
        case "logical":
          count(e.left);
          count(e.right);
          return;
        case "unary":
        case "toBool":
          count(e.operand);
          return;
        case "ternary":
          count(e.cond);
          count(e.then);
          count(e.else_);
          return;
        case "call":
          e.args.forEach(count);
          return;
        default:
          return;
      }
    };
    let tails = 0;
    const tail = (e: IrExpr): void => {
      if (e.kind === "ternary") {
        tail(e.then);
        tail(e.else_);
      } else if (this.isSelfCall(e) || this.accumulatingCall(e) !== null) tails++;
    };
    const stmts = (list: readonly IrStmt[]): void => {
      for (const s of list) {
        if (s.kind === "return" && s.value) {
          count(s.value);
          tail(s.value);
        } else if (s.kind === "if") {
          count(s.cond);
          stmts(s.then);
          if (s.else_) stmts(s.else_);
        } else if (s.kind === "block") stmts(s.body);
        else if (s.kind === "varDecl" && s.init) count(s.init);
        else if (s.kind === "assign") count(s.value);
        else if (s.kind === "exprStmt") count(s.expr);
      }
    };
    stmts(this.fn.body);
    return all - tails;
  }

  /** Allocates an activation's locals, binds its parameters to `args` and
   * opens its tail loop. */
  private openFrame(args: readonly string[], inline: Frame["inline"]): void {
    const { B, fn } = this;
    const frame: Frame = {
      slots: new Map(),
      loopLabel: null,
      accSlot: null,
      depthSlot: null,
      inline,
    };
    for (const local of fn.locals) {
      const kind = scalarKind(local.type);
      if (kind === null || local.boxed) continue;
      const slot = `%l${this.slotCount++}`;
      B.entryAllocas.push(`${slot} = alloca ${kind === "num" ? "i32" : "i1"} ; ${local.name}`);
      frame.slots.set(local.id, { slot, kind });
    }
    fn.params.forEach((p, i) => {
      const { slot, kind } = frame.slots.get(p.localId)!;
      B.line(`store ${kind === "num" ? "i32" : "i1"} ${args[i]!}, ptr ${slot}`);
    });
    this.frame = frame;
    if (inline === null && this.stackCheck) this.emitStackCheck();
    const tail = this.tailShape();
    if (!tail.loop) return;
    frame.depthSlot = `%l${this.slotCount++}`;
    B.entryAllocas.push(`${frame.depthSlot} = alloca i32 ; tail iterations left`);
    B.line(`store i32 ${TAIL_LIMIT}, ptr ${frame.depthSlot}`);
    if (tail.accumulates) {
      frame.accSlot = `%l${this.slotCount++}`;
      B.entryAllocas.push(`${frame.accSlot} = alloca i32 ; accumulator`);
      B.line(`store i32 0, ptr ${frame.accSlot}`);
    }
    frame.loopLabel = B.newLabel("tail");
    B.br(frame.loopLabel);
    B.startBlock(frame.loopLabel);
    // Tested here rather than at each tail call, where LLVM would merge the
    // test with the accumulator's overflow test into one select.
    const depth = B.tmp();
    const left = B.tmp();
    B.line(`${depth} = load i32, ptr ${frame.depthSlot}`);
    B.line(`${left} = icmp ne i32 ${depth}, 0`);
    this.require(left);
  }

  emit(): string {
    const { B, fn } = this;
    const params = fn.params.map((p, i) => `${scalarKind(p.type) === "num" ? "i32" : "i1"} %a${i}`);
    this.openFrame(
      fn.params.map((_, i) => `%a${i}`),
      null,
    );
    this.emitStmts(fn.body);
    // A number or boolean function never falls off its end; bail if it did.
    if (!B.isTerminated()) B.terminate(`ret ${BAIL}`);
    if (this.bailLabel !== null) {
      B.startBlock(this.bailLabel);
      B.terminate(`ret ${BAIL}`);
    }
    const symbol = `${mangleFunction(fn.name)}${INTEGER_CLONE_SUFFIX}`;
    return `define internal ${CLONE_RESULT} @${symbol}(${params.join(", ")}) #0 { ; ${fn.name} (integer clone)\n${B.render()}\n}`;
  }

  /** A non-tail self call of the clone's own activation, inlined: the
   * callee's int32 result (or boolean). Its own self calls stay calls. */
  private emitInlineCall(call: Extract<IrExpr, { kind: "call" }>): string {
    const { B } = this;
    const args = this.emitArgs(call);
    const outer = this.frame;
    const type = this.result === "num" ? "i32" : "i1";
    const result = `%l${this.slotCount++}`;
    B.entryAllocas.push(`${result} = alloca ${type} ; inlined result`);
    const done = B.newLabel("inlined");
    this.openFrame(args, { result, done });
    this.emitStmts(this.fn.body);
    if (!B.isTerminated()) B.br(this.bail());
    this.frame = outer;
    B.startBlock(done);
    const value = B.tmp();
    B.line(`${value} = load ${type}, ptr ${result}`);
    return value;
  }

  /** Whether a call is inlined (see inlineSelf). */
  private inlines(e: Extract<IrExpr, { kind: "call" }>): boolean {
    return this.inlineSelf && this.frame.inline === null && this.isSelfCall(e);
  }

  /** Whether the body has self tail calls, and whether one accumulates. */
  private tailShape(): { loop: boolean; accumulates: boolean } {
    let loop = false;
    let accumulates = false;
    const ret = (e: IrExpr): void => {
      if (e.kind === "ternary") {
        ret(e.then);
        ret(e.else_);
      } else if (this.isSelfCall(e)) loop = true;
      else if (this.accumulatingCall(e) !== null) loop = accumulates = true;
    };
    const stmts = (list: readonly IrStmt[]): void => {
      for (const s of list) {
        if (s.kind === "return" && s.value) ret(s.value);
        else if (s.kind === "if") {
          stmts(s.then);
          if (s.else_) stmts(s.else_);
        } else if (s.kind === "block") stmts(s.body);
      }
    };
    stmts(this.fn.body);
    return { loop, accumulates };
  }

  private isSelfCall(e: IrExpr): e is Extract<IrExpr, { kind: "call" }> {
    return e.kind === "call" && e.callee === this.fn.name;
  }

  /** `x + f(...)`, or `f(...) + x` with a call-free `x`: the self call and
   * the term the loop adds to its accumulator. */
  private accumulatingCall(
    e: IrExpr,
  ): { call: Extract<IrExpr, { kind: "call" }>; term: IrExpr } | null {
    if (this.result !== "num" || e.kind !== "bin" || e.op !== "+") return null;
    if (this.isSelfCall(e.right)) return { call: e.right, term: e.left };
    if (this.isSelfCall(e.left) && !callsAnything(e.right)) return { call: e.left, term: e.right };
    return null;
  }

  private bail(): string {
    return (this.bailLabel ??= this.B.newLabel("bail"));
  }

  /** Continue only when the i1 `ok` holds. */
  private require(ok: string): void {
    const { B } = this;
    this.host.declare(`declare i1 @llvm.expect.i1(i1, i1)`);
    const likely = B.tmp();
    B.line(`${likely} = call i1 @llvm.expect.i1(i1 ${ok}, i1 true)`);
    const next = B.newLabel("ok");
    B.condBr(likely, next, this.bail());
    B.startBlock(next);
  }

  private emitStackCheck(): void {
    const { B, host } = this;
    host.declare(`declare ptr @llvm.stacksave.p0()`);
    host.declare(`declare i1 @llvm.expect.i1(i1, i1)`);
    host.declare(`declare void @scr_stack_overflow()`);
    host.declare(STACK_GUARD_DECL);
    const sp = B.tmp();
    const guard = B.tmp();
    const low = B.tmp();
    const cold = B.tmp();
    B.line(`${sp} = call ptr @llvm.stacksave.p0()`);
    B.line(`${guard} = load ptr, ptr @scr_stack_guard`);
    B.line(`${low} = icmp ult ptr ${sp}, ${guard}`);
    B.line(`${cold} = call i1 @llvm.expect.i1(i1 ${low}, i1 false)`);
    const over = B.newLabel("stack.over");
    const ok = B.newLabel("stack.ok");
    B.condBr(cold, over, ok);
    B.startBlock(over);
    B.line(`call void @scr_stack_overflow()`);
    B.terminate(`ret ${BAIL}`);
    B.startBlock(ok);
  }

  private emitStmts(list: readonly IrStmt[]): void {
    for (const s of list) {
      if (this.B.isTerminated()) return;
      this.emitStmt(s);
    }
  }

  private emitStmt(s: IrStmt): void {
    const { B } = this;
    switch (s.kind) {
      case "return":
        this.emitReturn(s.value!);
        return;
      case "if": {
        const cond = this.emitBool(s.cond);
        const then = B.newLabel("if.t");
        const join = B.newLabel("if.j");
        const otherwise = s.else_ ? B.newLabel("if.e") : join;
        B.condBr(cond, then, otherwise);
        B.startBlock(then);
        this.emitStmts(s.then);
        if (!B.isTerminated()) B.br(join);
        if (s.else_) {
          B.startBlock(otherwise);
          this.emitStmts(s.else_);
          if (!B.isTerminated()) B.br(join);
        }
        B.startBlock(join);
        return;
      }
      case "block":
        this.emitStmts(s.body);
        return;
      case "varDecl":
      case "assign": {
        const target = this.frame.slots.get(s.localId)!;
        const value = s.kind === "varDecl" ? s.init! : s.value;
        if (target.kind === "num")
          B.line(`store i32 ${this.narrow(this.emitNum(value))}, ptr ${target.slot}`);
        else B.line(`store i1 ${this.emitBool(value)}, ptr ${target.slot}`);
        return;
      }
      case "exprStmt":
        if (scalarKind(s.expr.type) === "num") this.narrow(this.emitNum(s.expr));
        else this.emitBool(s.expr);
        return;
      default:
        throw new Error(`integer clone: unexpected statement ${s.kind}`);
    }
  }

  private emitReturn(e: IrExpr): void {
    const { B } = this;
    if (e.kind === "ternary") {
      const cond = this.emitBool(e.cond);
      const then = B.newLabel("ret.t");
      const otherwise = B.newLabel("ret.e");
      B.condBr(cond, then, otherwise);
      B.startBlock(then);
      this.emitReturn(e.then);
      B.startBlock(otherwise);
      this.emitReturn(e.else_);
      return;
    }
    if (this.frame.loopLabel !== null) {
      if (this.isSelfCall(e)) return this.emitTailCall(e, null);
      const accumulating = this.accumulatingCall(e);
      if (accumulating) return this.emitTailCall(accumulating.call, accumulating.term);
    }
    const inline = this.frame.inline;
    if (this.result === "bool") {
      const value = this.emitBool(e);
      if (inline) {
        B.line(`store i1 ${value}, ptr ${inline.result}`);
        B.br(inline.done);
        return;
      }
      const wide = B.tmp();
      B.line(`${wide} = zext i1 ${value} to i32`);
      B.terminate(`ret ${CLONE_RESULT} ${this.result32(wide)}`);
      return;
    }
    let value = this.emitNum(e);
    if (this.frame.accSlot !== null) {
      const acc = B.tmp();
      B.line(`${acc} = load i32, ptr ${this.frame.accSlot}`);
      value = this.add("+", { name: acc, wide: false }, value);
    }
    if (inline) {
      B.line(`store i32 ${this.narrow(value)}, ptr ${inline.result}`);
      B.br(inline.done);
      return;
    }
    if (value.wide) {
      B.terminate(`ret ${CLONE_RESULT} ${value.name}`);
      return;
    }
    B.terminate(`ret ${CLONE_RESULT} ${this.result32(value.name)}`);
  }

  private emitTailCall(call: Extract<IrExpr, { kind: "call" }>, term: IrExpr | null): void {
    const { B } = this;
    // `f(...) + x` evaluates its call-free term first; the order is
    // unobservable.
    const addend = term === null ? null : this.emitNum(term);
    const args = this.emitArgs(call);
    if (addend !== null) {
      // A BAIL term stops the loop at once: a pending stack overflow must
      // not keep running calls.
      const acc = B.tmp();
      B.line(`${acc} = load i32, ptr ${this.frame.accSlot!}`);
      const sum = this.add("+", { name: acc, wide: false }, addend);
      B.line(`store i32 ${sum.name}, ptr ${this.frame.accSlot!}`);
    }
    this.fn.params.forEach((p, i) => {
      const { slot, kind } = this.frame.slots.get(p.localId)!;
      B.line(`store ${kind === "num" ? "i32" : "i1"} ${args[i]!}, ptr ${slot}`);
    });
    const depth = B.tmp();
    const next = B.tmp();
    B.line(`${depth} = load i32, ptr ${this.frame.depthSlot!}`);
    B.line(`${next} = sub i32 ${depth}, 1`);
    B.line(`store i32 ${next}, ptr ${this.frame.depthSlot!}`);
    B.br(this.frame.loopLabel!);
  }

  private emitArgs(call: Extract<IrExpr, { kind: "call" }>): string[] {
    return call.args.map((a) =>
      scalarKind(a.type) === "num" ? this.narrow(this.emitNum(a)) : this.emitBool(a),
    );
  }

  private emitCall(call: Extract<IrExpr, { kind: "call" }>): string {
    const { B } = this;
    const args = this.emitArgs(call);
    const types = call.args.map((a) => (scalarKind(a.type) === "num" ? "i32" : "i1"));
    const result = B.tmp();
    B.line(
      `${result} = call ${CLONE_RESULT} @${mangleFunction(call.callee)}${INTEGER_CLONE_SUFFIX}(${args.map((a, i) => `${types[i]} ${a}`).join(", ")})`,
    );
    return result;
  }

  /** The successful CLONE_RESULT of the i32 `value`. */
  private result32(value: string): string {
    const pair = this.B.tmp();
    this.B.line(`${pair} = insertvalue ${CLONE_RESULT} { i32 poison, i1 false }, i32 ${value}, 0`);
    return pair;
  }

  /** The int32 of `v`, forwarding a bail. */
  private narrow(v: NumValue): string {
    if (!v.wide) return v.name;
    return this.cloneValue(v.name);
  }

  /** The value of the clone result `pair`, forwarding a bail. The bail
   * returns `pair` itself, so its registers pass through unchanged. */
  private cloneValue(pair: string): string {
    const { B } = this;
    this.host.declare(`declare i1 @llvm.expect.i1(i1, i1)`);
    const bailed = B.tmp();
    const unlikely = B.tmp();
    const value = B.tmp();
    B.line(`${bailed} = extractvalue ${CLONE_RESULT} ${pair}, 1`);
    B.line(`${unlikely} = call i1 @llvm.expect.i1(i1 ${bailed}, i1 false)`);
    const forward = B.newLabel("forward");
    const next = B.newLabel("ok");
    B.condBr(unlikely, forward, next);
    B.startBlock(forward);
    B.terminate(`ret ${CLONE_RESULT} ${pair}`);
    B.startBlock(next);
    B.line(`${value} = extractvalue ${CLONE_RESULT} ${pair}, 0`);
    return value;
  }

  private widen(v: NumValue): string {
    return v.wide ? v.name : this.result32(v.name);
  }

  /** Checked `+`/`-`. */
  private add(op: "+" | "-", left: NumValue, right: NumValue): NumValue {
    const l = this.narrow(left);
    const r = this.narrow(right);
    return { name: this.overflowing(op === "+" ? "sadd" : "ssub", l, r), wide: false };
  }

  private overflowing(op: "sadd" | "ssub" | "smul", left: string, right: string): string {
    const { B } = this;
    this.host.declare(`declare { i32, i1 } @llvm.${op}.with.overflow.i32(i32, i32)`);
    const pair = B.tmp();
    const value = B.tmp();
    const overflow = B.tmp();
    const ok = B.tmp();
    B.line(`${pair} = call { i32, i1 } @llvm.${op}.with.overflow.i32(i32 ${left}, i32 ${right})`);
    B.line(`${value} = extractvalue { i32, i1 } ${pair}, 0`);
    B.line(`${overflow} = extractvalue { i32, i1 } ${pair}, 1`);
    B.line(`${ok} = xor i1 ${overflow}, true`);
    this.require(ok);
    return value;
  }

  private emitNum(e: IrExpr): NumValue {
    const { B } = this;
    switch (e.kind) {
      case "numLit":
        return { name: String(e.value), wide: false };
      case "varRef": {
        const value = B.tmp();
        B.line(`${value} = load i32, ptr ${this.frame.slots.get(e.localId)!.slot}`);
        return { name: value, wide: false };
      }
      case "call":
        if (this.inlines(e)) return { name: this.emitInlineCall(e), wide: false };
        return { name: this.emitCall(e), wide: true };
      case "unary": {
        const operand = this.narrow(this.emitNum(e.operand));
        const value = B.tmp();
        if (e.op === "~") {
          B.line(`${value} = xor i32 ${operand}, -1`);
          return { name: value, wide: false };
        }
        // -0 is not an int32.
        const nonzero = B.tmp();
        B.line(`${nonzero} = icmp ne i32 ${operand}, 0`);
        this.require(nonzero);
        return { name: this.overflowing("ssub", "0", operand), wide: false };
      }
      case "ternary": {
        const cond = this.emitBool(e.cond);
        const then = B.newLabel("sel.t");
        const otherwise = B.newLabel("sel.e");
        const join = B.newLabel("sel.j");
        // Both arms join as one kind: CLONE_RESULT when either is untested.
        const wide = mayBail(e);
        const arm = (label: string, value: IrExpr): { name: string; label: string } => {
          B.startBlock(label);
          const v = this.emitNum(value);
          const name = wide ? this.widen(v) : v.name;
          const end = B.currentLabel();
          B.br(join);
          return { name, label: end };
        };
        B.condBr(cond, then, otherwise);
        const a = arm(then, e.then);
        const b = arm(otherwise, e.else_);
        B.startBlock(join);
        const value = B.tmp();
        B.line(
          `${value} = phi ${wide ? CLONE_RESULT : "i32"} [ ${a.name}, %${a.label} ], [ ${b.name}, %${b.label} ]`,
        );
        return { name: value, wide };
      }
      case "bin": {
        const left = this.emitNum(e.left);
        const right = this.emitNum(e.right);
        if (e.op === "+" || e.op === "-") return this.add(e.op, left, right);
        const l = this.narrow(left);
        const r = this.narrow(right);
        const value = B.tmp();
        switch (e.op) {
          case "*": {
            const product = this.overflowing("smul", l, r);
            // A zero product of a negative factor is -0.
            const either = B.tmp();
            const negative = B.tmp();
            const zero = B.tmp();
            const minusZero = B.tmp();
            const ok = B.tmp();
            B.line(`${either} = or i32 ${l}, ${r}`);
            B.line(`${negative} = icmp slt i32 ${either}, 0`);
            B.line(`${zero} = icmp eq i32 ${product}, 0`);
            B.line(`${minusZero} = and i1 ${zero}, ${negative}`);
            B.line(`${ok} = xor i1 ${minusZero}, true`);
            this.require(ok);
            return { name: product, wide: false };
          }
          case "%": {
            // x % 0 is NaN; a zero remainder of a negative dividend is -0.
            // x % -1 is (-)0 like x % 1, which also avoids srem's overflow.
            const nonzero = B.tmp();
            const minusOne = B.tmp();
            const divisor = B.tmp();
            B.line(`${nonzero} = icmp ne i32 ${r}, 0`);
            this.require(nonzero);
            B.line(`${minusOne} = icmp eq i32 ${r}, -1`);
            B.line(`${divisor} = select i1 ${minusOne}, i32 1, i32 ${r}`);
            B.line(`${value} = srem i32 ${l}, ${divisor}`);
            const zero = B.tmp();
            const negative = B.tmp();
            const minusZero = B.tmp();
            const ok = B.tmp();
            B.line(`${zero} = icmp eq i32 ${value}, 0`);
            B.line(`${negative} = icmp slt i32 ${l}, 0`);
            B.line(`${minusZero} = and i1 ${zero}, ${negative}`);
            B.line(`${ok} = xor i1 ${minusZero}, true`);
            this.require(ok);
            return { name: value, wide: false };
          }
          case "&":
          case "|":
          case "^":
            B.line(
              `${value} = ${e.op === "&" ? "and" : e.op === "|" ? "or" : "xor"} i32 ${l}, ${r}`,
            );
            return { name: value, wide: false };
          case "<<":
          case ">>":
          case ">>>": {
            const count = B.tmp();
            B.line(`${count} = and i32 ${r}, 31`);
            const op = e.op === "<<" ? "shl" : e.op === ">>" ? "ashr" : "lshr";
            B.line(`${value} = ${op} i32 ${l}, ${count}`);
            if (e.op === ">>>") {
              // A Uint32 result of 2^31 or more is not an int32.
              const fits = B.tmp();
              B.line(`${fits} = icmp sge i32 ${value}, 0`);
              this.require(fits);
            }
            return { name: value, wide: false };
          }
          default:
            throw new Error(`integer clone: unexpected number operator ${e.op}`);
        }
      }
      default:
        throw new Error(`integer clone: unexpected number expression ${e.kind}`);
    }
  }

  private emitBool(e: IrExpr): string {
    const { B } = this;
    switch (e.kind) {
      case "boolLit":
        return e.value ? "true" : "false";
      case "varRef": {
        const value = B.tmp();
        B.line(`${value} = load i1, ptr ${this.frame.slots.get(e.localId)!.slot}`);
        return value;
      }
      case "call": {
        if (this.inlines(e)) return this.emitInlineCall(e);
        const result = this.cloneValue(this.emitCall(e));
        const value = B.tmp();
        B.line(`${value} = trunc i32 ${result} to i1`);
        return value;
      }
      case "unary": {
        const operand = this.emitBool(e.operand);
        const value = B.tmp();
        B.line(`${value} = xor i1 ${operand}, true`);
        return value;
      }
      case "toBool": {
        if (scalarKind(e.operand.type) === "bool") return this.emitBool(e.operand);
        const operand = this.narrow(this.emitNum(e.operand));
        const value = B.tmp();
        B.line(`${value} = icmp ne i32 ${operand}, 0`);
        return value;
      }
      case "bin": {
        const value = B.tmp();
        if (scalarKind(e.left.type) === "bool") {
          const l = this.emitBool(e.left);
          const r = this.emitBool(e.right);
          B.line(`${value} = icmp ${e.op === "===" ? "eq" : "ne"} i1 ${l}, ${r}`);
          return value;
        }
        const l = this.narrow(this.emitNum(e.left));
        const r = this.narrow(this.emitNum(e.right));
        const predicate: Record<string, string> = {
          "<": "slt",
          "<=": "sle",
          ">": "sgt",
          ">=": "sge",
          "===": "eq",
          "!==": "ne",
        };
        B.line(`${value} = icmp ${predicate[e.op]!} i32 ${l}, ${r}`);
        return value;
      }
      case "logical": {
        const left = this.emitBool(e.left);
        const leftLabel = B.currentLabel();
        const right = B.newLabel("logic.r");
        const join = B.newLabel("logic.j");
        if (e.op === "&&") B.condBr(left, right, join);
        else B.condBr(left, join, right);
        B.startBlock(right);
        const r = this.emitBool(e.right);
        const rightLabel = B.currentLabel();
        B.br(join);
        B.startBlock(join);
        const value = B.tmp();
        B.line(
          `${value} = phi i1 [ ${e.op === "&&" ? "false" : "true"}, %${leftLabel} ], [ ${r}, %${rightLabel} ]`,
        );
        return value;
      }
      case "ternary": {
        const cond = this.emitBool(e.cond);
        const then = B.newLabel("sel.t");
        const otherwise = B.newLabel("sel.e");
        const join = B.newLabel("sel.j");
        B.condBr(cond, then, otherwise);
        B.startBlock(then);
        const a = this.emitBool(e.then);
        const aLabel = B.currentLabel();
        B.br(join);
        B.startBlock(otherwise);
        const b = this.emitBool(e.else_);
        const bLabel = B.currentLabel();
        B.br(join);
        B.startBlock(join);
        const value = B.tmp();
        B.line(`${value} = phi i1 [ ${a}, %${aLabel} ], [ ${b}, %${bLabel} ]`);
        return value;
      }
      default:
        throw new Error(`integer clone: unexpected boolean expression ${e.kind}`);
    }
  }
}

/** The dispatcher of member `fn` for the direct-call entry `entry` (the
 * ordinary symbol, or its i32 entry: `int32Params`/`int32Result` give that
 * entry's i32 positions). It has the entry's signature, so a call site
 * only switches its target. */
export function emitIntegerDispatcher(
  fn: IrFunction,
  host: IntegerCloneHost,
  entry: string,
  int32Params: readonly boolean[],
  int32Result: boolean,
): string {
  host.declare(`declare i32 @llvm.fptosi.sat.i32.f64(double)`);
  host.declare(`declare i1 @llvm.expect.i1(i1, i1)`);
  const lines: string[] = [];
  const params: string[] = [];
  const entryArgs: string[] = [];
  const cloneArgs: string[] = [];
  const exact: string[] = [];
  fn.params.forEach((p, i) => {
    if (scalarKind(p.type) === "bool") {
      params.push(`i1 %p${i}`);
      entryArgs.push(`i1 %p${i}`);
      cloneArgs.push(`i1 %p${i}`);
    } else if (int32Params[i]) {
      params.push(`i32 %p${i}`);
      entryArgs.push(`i32 %p${i}`);
      cloneArgs.push(`i32 %p${i}`);
    } else {
      // Exactly an int32: the bits round-trip (so never -0 or NaN).
      params.push(`double %p${i}`);
      entryArgs.push(`double %p${i}`);
      cloneArgs.push(`i32 %i${i}`);
      lines.push(
        `  %i${i} = call i32 @llvm.fptosi.sat.i32.f64(double %p${i})`,
        `  %d${i} = sitofp i32 %i${i} to double`,
        `  %x${i} = bitcast double %d${i} to i64`,
        `  %y${i} = bitcast double %p${i} to i64`,
        `  %e${i} = icmp eq i64 %x${i}, %y${i}`,
      );
      exact.push(`%e${i}`);
    }
  });
  let all = "true";
  exact.forEach((e, i) => {
    if (i === 0) all = e;
    else {
      lines.push(`  %all${i} = and i1 ${all}, ${e}`);
      all = `%all${i}`;
    }
  });
  const bool = scalarKind(fn.returnType) === "bool";
  const ret = bool ? "i1" : int32Result ? "i32" : "double";
  const dummy = bool ? "false" : int32Result ? "0" : "0.0";
  lines.push(
    `  %fast = call i1 @llvm.expect.i1(i1 ${all}, i1 true)`,
    `  br i1 %fast, label %clone, label %ordinary`,
    `clone:`,
    `  %r = call ${CLONE_RESULT} @${mangleFunction(fn.name)}${INTEGER_CLONE_SUFFIX}(${cloneArgs.join(", ")})`,
    `  %bailed = extractvalue ${CLONE_RESULT} %r, 1`,
    `  %ok = xor i1 %bailed, true`,
    `  %n = extractvalue ${CLONE_RESULT} %r, 0`,
    bool
      ? `  %v = trunc i32 %n to i1`
      : int32Result
        ? `  %v = add i32 %n, 0`
        : `  %v = sitofp i32 %n to double`,
  );
  lines.push(
    `  %likely = call i1 @llvm.expect.i1(i1 %ok, i1 true)`,
    `  br i1 %likely, label %done, label %bail`,
    `done:`,
    `  ret ${ret} %v`,
    `bail:`,
    // A stack overflow left its RangeError pending: forward it.
    ...host.pendingTestLines("%pending"),
    `  br i1 %pending, label %thrown, label %ordinary`,
    `thrown:`,
    `  ret ${ret} ${dummy}`,
    `ordinary:`,
    `  %o = call ${ret} @${entry}(${entryArgs.join(", ")})`,
    `  ret ${ret} %o`,
  );
  return `define internal ${ret} @${entry}${INTEGER_DISPATCH_SUFFIX}(${params.join(", ")}) #0 { ; ${fn.name} (integer dispatch)\nentry:\n${lines.join("\n")}\n}`;
}

/** The integer clone of member `fn`. */
export function emitIntegerClone(
  fn: IrFunction,
  host: IntegerCloneHost,
  stackCheck: boolean,
): string {
  return new CloneEmitter(fn, host, stackCheck).emit();
}

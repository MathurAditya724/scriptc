/* LLVM text for a native module, in the shape clang's frontend emits for
 * the equivalent C before any LLVM pass runs: an alloca per parameter and
 * local, explicit loads and stores, `nsw` on signed arithmetic, `inbounds`
 * (and `nuw` for unsigned indices) on pointer offsets, loop metadata for
 * C11's forward-progress rule, and the attributes, ABI attributes and
 * module flags of the probe (probe.ts). In optimizing builds it also has
 * clang's lifetime markers, the cleanup blocks that end the locals a jump
 * leaves, and the range of boolean loads. clang's pipeline then turns it
 * into the code it makes from the C version.
 *
 * The -O0 (dev) builds compile this IR as it is, so it also follows the
 * details of clang's frontend that -O2 removes: values are evaluated in
 * clang's order (the stored value before the address, the right operand of
 * a compound assignment before the left), constant addresses and constant
 * conversions are folded, unreachable code is left out, and the return
 * block and return value slot are placed and dropped as clang's
 * `EmitReturnBlock` and `EmitFunctionEpilog` do.
 *
 * Values and blocks are numbered as clang numbers them. A C unit gets the
 * module's functions in place of the stand-in bodies its header defines
 * them with (nativeShapes, mergeNativeModule), which keeps where clang puts
 * each function and the order of every use list, and the counter LLVM
 * names new globals with is set back to where clang's frontend left it
 * (nameCounter): the backend's results depend on all three. */
import {
  alignOfType,
  sizeOfType,
  type NativeBinaryOp,
  type NativeExpr,
  type NativeFunction,
  type NativeMemType,
  type NativeModule,
  type NativeStmt,
  type NativeStruct,
  type NativeType,
} from "./ir.js";
import type { NativeProbe } from "./probe.js";

interface Value {
  ty: string;
  v: string;
}

type LoopStmt = Extract<NativeStmt, { kind: "loop" }>;

/** Stand-ins for the metadata nodes of a boolean load's range, numbered
 * with the module's other nodes (ModuleEmitter.metadata). */
const BOOL_RANGE = "!<bool.range>";
const NOUNDEF = "!<noundef>";

/** References a function body makes to values outside it, in clang's
 * order: lifetime markers, the memory intrinsics, thread-local accesses,
 * constant field addresses of globals, and other globals and functions. */
const OUTSIDE_REFERENCE =
  /@llvm\.lifetime\.(start|end)\.p0\b|@llvm\.(memset|memcpy)\.[\w.]+|@llvm\.threadlocal\.address\.p0\(ptr align \d+ @([\w.$]+)\)|getelementptr inbounds nuw \((%struct\.[\w.]+), ptr @([\w.$]+), i32 0, i32 (\d+)\)|@([\w.$]+)/g;

function llType(t: NativeType): string {
  switch (t.kind) {
    case "int":
      return `i${t.bits}`;
    case "bool":
      return "i1";
    case "ptr":
    case "ref":
    case "arrayref":
      return "ptr";
    case "void":
      return "void";
  }
}

/** The LLVM type of a struct interface: clang's name for the C struct it
 * describes, which linking merges with the C unit's own type, or a name
 * apart from clang's for a struct with no C counterpart. */
function structType(def: NativeStruct): string {
  return def.cName === null ? `%native.${def.name}` : `%struct.${def.cName}`;
}

/** The type of `t` in memory: booleans are bytes, embedded structs and
 * arrays are aggregates. */
function memType(t: NativeMemType): string {
  switch (t.kind) {
    case "bool":
      return "i8";
    case "inline":
      return structType(t.def);
    case "array":
      return `[${t.length} x ${memType(t.element)}]`;
    default:
      return llType(t);
  }
}

/** The body of a struct's type definition, as clang writes it. */
function structBody(def: NativeStruct): string {
  return `{ ${def.fields.map((f) => memType(f.type)).join(", ")} }`;
}

/** The probe's key for the ABI attributes of a scalar type. */
function abiKey(t: NativeType): string | null {
  switch (t.kind) {
    case "int":
      return `${t.signed ? "s" : "u"}${t.bits}`;
    case "bool":
      return "bool";
    case "ptr":
    case "ref":
    case "arrayref":
      return "ptr";
    case "void":
      return null;
  }
}

/** A function body with its values and blocks numbered as clang numbers
 * them (`%0`, `%1`, ... after the parameters, the entry block unlabeled):
 * code generation is not independent of value names. */
function numberValues(lines: readonly string[], params: number): string[] {
  // The entry block takes the number after the parameters.
  const numbers = new Map<string, string>([["%entry", `%${params}`]]);
  let next = params + 1;
  for (const line of lines) {
    const def = line.match(/^ {2}(%[\w.]+) = /);
    if (def !== null) numbers.set(def[1]!, `%${next++}`);
    const label = line.match(/^([\w.]+):$/);
    if (label !== null && label[1] !== "entry") numbers.set(`%${label[1]}`, `%${next++}`);
  }
  const out: string[] = [];
  for (const line of lines) {
    if (line === "entry:") continue;
    const label = line.match(/^([\w.]+):$/);
    if (label !== null) {
      out.push(`${numbers.get(`%${label[1]}`)!.slice(1)}:`);
      continue;
    }
    out.push(line.replace(/%[\w.]+/g, (name) => numbers.get(name) ?? name));
  }
  return out;
}

/** Whether a pointer value is a constant: a global that is not
 * thread-local, or a constant expression on one. */
function isConstantAddress(v: string): boolean {
  return v.startsWith("@") || v.startsWith("getelementptr ");
}

/** The labels a terminator branches to. */
function targets(line: string): string[] {
  return [...line.matchAll(/label %([\w.]+)/g)].map((m) => m[1]!);
}

function isTerminator(line: string | undefined): boolean {
  return line !== undefined && /^ {2}(br|switch|ret|unreachable)\b/.test(line);
}

function signedLiteral(value: bigint, bits: number): string {
  const mask = (1n << BigInt(bits)) - 1n;
  let v = value & mask;
  if (v >> BigInt(bits - 1) === 1n) v -= 1n << BigInt(bits);
  return v.toString();
}

interface Block {
  label: string;
  lines: string[];
}

/** A branch target, as clang's `JumpDest`: the number of cleanups active
 * where it was made, and the index a branch through cleanups stores for
 * it in the cleanup destination slot. */
interface JumpDest {
  label: string;
  depth: number;
  index: number;
}

/** The end of a local's lifetime, as clang's cleanup for it: the block
 * that runs it for branches out of its scope, the destinations branched to
 * through it, and those of them that leave it for the enclosing cleanup's
 * scope ("branch-afters", with their indices). */
interface Cleanup {
  slot: number;
  entry: string | null;
  branches: Set<string>;
  afters: [string, number][];
}

interface Loop {
  breakDest: JumpDest;
  continueDest: JumpDest;
}

/** Function bodies follow clang's code generation for the equivalent C
 * (CGStmt.cpp, CGCleanup.cpp): blocks are placed after the block being
 * filled, or last when there is none; a jump into an enclosing scope runs
 * the lifetime ends of the locals it leaves through cleanup blocks, with a
 * cleanup destination slot and a switch where several jumps share them;
 * and a cleanup block with one predecessor merges into it. Optimizing
 * builds mark local lifetimes (the probe shows whether a build does);
 * without the markers there are no cleanups, and the code is clang's -O0
 * code. */
class FunctionEmitter {
  private readonly blocks: Block[] = [];
  /** The block being filled; null after a jump, until the next block. */
  private cur: Block | null = null;
  private temp = 0;
  private label = 0;
  private readonly loops: Loop[] = [];
  /** The innermost loop's header and its `!llvm.loop` node: a branch built
   * to the header carries the node, as clang's `LoopInfoStack` adds it. */
  private readonly loopInfo: { header: string; md: number | null }[] = [];
  private readonly cleanups: Cleanup[] = [];
  private nextDestIndex = 1;
  private readonly returnDest: JumpDest = {
    label: "return",
    depth: 0,
    index: this.nextDestIndex++,
  };
  private destSlot: string | null = null;
  private destSlots = 0;
  /** The allocas at the start of the entry block. */
  private allocas = 0;
  private unreachable: string | null = null;
  /** The references the body makes to values outside it, in the order
   * clang creates them (OUTSIDE_REFERENCE): a call's callee before its
   * arguments. */
  readonly references: string[] = [];
  /** A callee already in `references`, for the call line that names it. */
  private calleeNoted: string | null = null;

  constructor(
    private readonly fn: NativeFunction,
    private readonly module: ModuleEmitter,
  ) {}

  private t(): string {
    return `%t${this.temp++}`;
  }
  private newLabel(hint: string): string {
    return `${hint}${this.label++}`;
  }
  /** No block is being filled, or it ends in a terminator. */
  private get terminated(): boolean {
    return this.cur === null || isTerminator(this.cur.lines.at(-1));
  }
  private emit(line: string): void {
    if (this.terminated) this.startBlock(this.newLabel("dead"));
    this.cur!.lines.push(`  ${line}`);
    for (const m of line.matchAll(OUTSIDE_REFERENCE)) {
      if (m[0] === `@${this.calleeNoted}`) this.calleeNoted = null;
      else this.references.push(m[0]);
    }
  }
  /** A terminator built at the end of the current block. */
  private terminate(line: string): void {
    const loop = this.loopInfo.at(-1);
    if (loop !== undefined && loop.md !== null && targets(line).includes(loop.header))
      line += `, !llvm.loop !${loop.md}`;
    this.emit(line);
  }
  /** clang's `EmitBranch`: a branch from an open block to `label`, and no
   * current block afterwards. */
  private branchTo(label: string): void {
    if (!this.terminated) this.terminate(`br label %${label}`);
    this.cur = null;
  }
  /** clang's `EmitBlock`: branches to `label` from an open block and makes
   * it the current block, placed after the previous one. A `finished` block
   * that nothing branches to is left out. */
  private startBlock(label: string, finished = false): void {
    const at = this.cur;
    this.branchTo(label);
    if (finished && this.uses(label) === 0) return;
    const block: Block = { label, lines: [] };
    if (at !== null) this.blocks.splice(this.blocks.indexOf(at) + 1, 0, block);
    else this.blocks.push(block);
    this.cur = block;
  }
  private uses(label: string): number {
    let n = 0;
    for (const b of this.blocks)
      for (const line of b.lines) for (const t of targets(line)) if (t === label) n++;
    return n;
  }
  /** The block that branches to `block`, when only one does. */
  private singlePredecessor(block: Block): Block | null {
    const preds = this.blocks.filter((b) => targets(b.lines.at(-1) ?? "").includes(block.label));
    return preds.length === 1 ? preds[0]! : null;
  }
  private retarget(from: string, to: string): void {
    const pattern = new RegExp(`label %${from.replace(/\./g, "\\.")}(?![\\w.])`, "g");
    for (const b of this.blocks)
      b.lines = b.lines.map((line) => line.replace(pattern, `label %${to}`));
  }
  /** An alloca at the end of the entry block's allocas, where clang's
   * `AllocaInsertPt` puts them. */
  private newAlloca(line: string): void {
    this.blocks[0]!.lines.splice(this.allocas++, 0, `  ${line}`);
  }
  private removeAlloca(name: string): void {
    const entry = this.blocks[0]!.lines;
    entry.splice(
      entry.findIndex((l) => l.startsWith(`  ${name} = alloca `)),
      1,
    );
    this.allocas--;
  }
  private slotName(index: number): string {
    return `%s${index}.${this.fn.slots[index]!.name}`;
  }
  private align(t: NativeType): number {
    return alignOfType(t, this.module.probe.pointerBytes);
  }
  /** The return value slot holds a boolean as i1, as clang's does. */
  private retvalType(): string {
    return this.fn.returnType.kind === "bool" ? "i1" : memType(this.fn.returnType);
  }

  run(linkage: string, attrGroup: number): string {
    const fn = this.fn;
    const probe = this.module.probe;
    const params = fn.params
      .map((p, i) => {
        const attrs = probe.paramAttributes.get(abiKey(p.type)!) ?? "noundef";
        return `${llType(p.type)}${attrs ? ` ${attrs}` : ""} %${i}`;
      })
      .join(", ");
    const retKey = abiKey(fn.returnType);
    const retAttrs = retKey === null ? "" : (probe.returnAttributes.get(retKey) ?? "");
    const header = `define ${linkage ? `${linkage} ` : ""}${retAttrs ? `${retAttrs} ` : ""}${llType(fn.returnType)} @${fn.name}(${params}) #${attrGroup}${probe.definitionSuffix} {`;
    this.cur = { label: "entry", lines: [] };
    this.blocks.push(this.cur);
    if (fn.returnType.kind !== "void")
      this.newAlloca(`%retval = alloca ${this.retvalType()}, align ${this.align(fn.returnType)}`);
    fn.params.forEach((_, i) => this.declareSlot(i));
    fn.params.forEach((p, i) => this.storeSlot(i, { ty: llType(p.type), v: `%${i}` }));
    this.statements(fn.body);
    // FinishFunction: the function body's own locals end.
    this.popCleanups(0);
    this.epilogue();
    const lines = this.blocks.flatMap((b, i) =>
      i === 0 ? ["entry:", ...b.lines] : ["", `${b.label}:`, ...b.lines],
    );
    return [header, ...numberValues(lines, fn.params.length), "}"].join("\n");
  }

  private declareSlot(slot: number): void {
    const s = this.fn.slots[slot]!;
    this.newAlloca(
      `${this.slotName(slot)} = alloca ${memType(s.type)}, align ${this.align(s.type)}`,
    );
  }

  /** The return block and `ret`, as clang's `EmitReturnBlock` and
   * `EmitFunctionEpilog` place them. An open block that is empty, or that
   * no `return` jumps past, becomes the return block; the block of a single
   * branch to it takes the `ret` in place of the branch. The return value
   * slot goes when its store dominates the `ret`, which then returns the
   * stored value. The unreachable block of cleanup switches comes last. */
  private epilogue(): void {
    const jumps = this.uses("return");
    if (this.cur !== null) {
      if (this.cur.lines.length === 0 || jumps === 0) this.retarget("return", this.cur.label);
      else this.startBlock("return");
    } else {
      const single =
        jumps === 1 ? this.blocks.find((b) => b.lines.at(-1) === "  br label %return") : undefined;
      if (single !== undefined) {
        single.lines.pop();
        this.cur = single;
      } else this.startBlock("return");
    }
    const block = this.cur!;
    if (this.fn.returnType.kind === "void") block.lines.push("  ret void");
    else {
      const ty = this.retvalType();
      const value = this.dominatingReturnStore(block);
      if (value !== null) block.lines.push(`  ret ${ty} ${value}`);
      else {
        const r = this.t();
        block.lines.push(
          `  ${r} = load ${ty}, ptr %retval, align ${this.align(this.fn.returnType)}`,
        );
        block.lines.push(`  ret ${ty} ${r}`);
      }
    }
    if (this.unreachable !== null && this.uses(this.unreachable) > 0)
      this.blocks.push({ label: this.unreachable, lines: ["  unreachable"] });
  }

  /** clang's `findDominatingStoreToReturnValue` for a `ret` at the end of
   * `at`: with one store to the return slot, the store if its block reaches
   * `at` through single predecessors; with several, a store that ends `at`
   * but for lifetime ends. Removes the store (and the slot, when it was the
   * only one) and gives the stored value. */
  private dominatingReturnStore(at: Block): string | null {
    const storeLine = /^ {2}store \S+ (\S+), ptr %retval, align \d+$/;
    const users: [Block, number][] = [];
    for (const b of this.blocks)
      b.lines.forEach((line, i) => {
        if (/ptr %retval(?![\w.])/.test(line) && !line.startsWith("  %retval = "))
          users.push([b, i]);
      });
    let found: [Block, number] | null = null;
    if (users.length !== 1) {
      for (let i = at.lines.length - 1; i >= 0; i--) {
        if (/^ {2}call void @llvm\.lifetime\.end\./.test(at.lines[i]!)) continue;
        if (storeLine.test(at.lines[i]!)) found = [at, i];
        break;
      }
    } else if (storeLine.test(users[0]![0].lines[users[0]![1]]!)) {
      const target = users[0]![0];
      let block: Block | null = at;
      const seen = new Set<Block>();
      while (block !== target && block !== null && !seen.has(block)) {
        seen.add(block);
        block = this.singlePredecessor(block);
      }
      if (block === target) found = users[0]!;
    }
    if (found === null) return null;
    const [block, index] = found;
    const value = block.lines[index]!.match(storeLine)![1]!;
    block.lines.splice(index, 1);
    if (users.length === 1) this.removeAlloca("%retval");
    return value;
  }

  // ── scopes and cleanups (clang's CGCleanup.cpp) ──────────────────────

  private dest(hint: string): JumpDest {
    return { label: this.newLabel(hint), depth: this.cleanups.length, index: this.nextDestIndex++ };
  }

  /** Statements in a scope of their own: the locals they declare end
   * with it. */
  private scoped(body: () => void): void {
    const depth = this.cleanups.length;
    body();
    this.popCleanups(depth);
  }

  private popCleanups(depth: number): void {
    while (this.cleanups.length > depth) this.popCleanup(depth < this.cleanups.length - 1);
  }

  private lifetime(which: "start" | "end", slot: number): void {
    const lifetime = this.module.probe.lifetime!;
    this.module.needIntrinsic(which === "start" ? lifetime.start : lifetime.end);
    const attrs = lifetime.callAttributes;
    const size = lifetime.sized
      ? `i64 ${sizeOfType(this.fn.slots[slot]!.type, this.module.probe.pointerBytes)}, `
      : "";
    this.emit(
      `call void @llvm.lifetime.${which}.p0(${size}ptr ${this.slotName(slot)})${attrs === null ? "" : ` #${this.module.group(attrs)}`}`,
    );
  }

  private cleanupDestSlot(): string {
    if (this.destSlot === null) {
      this.destSlot = `%cleanup.dest.slot${this.destSlots++}`;
      this.newAlloca(`${this.destSlot} = alloca i32, align 4`);
    }
    return this.destSlot;
  }

  private normalEntry(cleanup: Cleanup): string {
    return (cleanup.entry ??= this.newLabel("cleanup"));
  }

  /** clang's `EmitBranchThroughCleanup`: a jump to `dest` that runs the
   * cleanups between here and it. */
  private branchThrough(dest: JumpDest): void {
    if (this.terminated) return;
    const top = this.cleanups.length;
    if (top <= dest.depth) {
      this.terminate(`br label %${dest.label}`);
      this.cur = null;
      return;
    }
    const loop = this.loopInfo.at(-1);
    const md =
      loop !== undefined && loop.md !== null && loop.header === dest.label
        ? `, !llvm.loop !${loop.md}`
        : "";
    this.emit(`store i32 ${dest.index}, ptr ${this.cleanupDestSlot()}, align 4`);
    this.emit(`br label %${this.normalEntry(this.cleanups[top - 1]!)}${md}`);
    for (let i = top; dest.depth < i;) {
      const cleanup = this.cleanups[--i]!;
      if (!(dest.depth < i)) {
        if (!cleanup.branches.has(dest.label)) {
          cleanup.branches.add(dest.label);
          cleanup.afters.push([dest.label, dest.index]);
        }
        break;
      }
      if (cleanup.branches.has(dest.label)) break;
      cleanup.branches.add(dest.label);
    }
    this.cur = null;
  }

  /** clang's `PopCleanupBlock` for the innermost local. */
  private popCleanup(fallthroughIsBranchThrough: boolean): void {
    const cleanup = this.cleanups.at(-1)!;
    const source = this.cur;
    const hasBranches = cleanup.branches.size > 0;
    const hasFallthrough = source !== null;
    const prebranched = source !== null && isTerminator(source.lines.at(-1));
    if (!hasFallthrough && !hasBranches) {
      this.cleanups.pop();
      return;
    }
    if (hasFallthrough && !prebranched && !hasBranches) {
      this.cleanups.pop();
      this.lifetime("end", cleanup.slot);
      return;
    }
    const entry = this.normalEntry(cleanup);
    if (hasFallthrough && !prebranched)
      this.emit(`store i32 0, ptr ${this.cleanupDestSlot()}, align 4`);
    this.startBlock(entry);
    const hasBranchThroughs = cleanup.branches.size !== cleanup.afters.length;
    const throughDest =
      hasBranchThroughs || (source !== null && fallthroughIsBranchThrough)
        ? this.normalEntry(this.cleanups.at(-2)!)
        : null;
    let fallthroughDest: string | null = null;
    const exit: string[] = [];
    if (!hasBranchThroughs && !hasFallthrough && cleanup.afters.length === 1) {
      // The one store to the destination slot is dead.
      const slot = this.cleanupDestSlot();
      const pattern = new RegExp(`ptr ${slot.replace(/\./g, "\\.")}(?![\\w.])`);
      const users = this.blocks.flatMap((b) =>
        b.lines.flatMap((line, i) =>
          pattern.test(line) && !line.startsWith(`  ${slot} = `) ? [[b, i] as const] : [],
        ),
      );
      if (users.length === 1) {
        users[0]![0].lines.splice(users[0]![1], 1);
        this.removeAlloca(slot);
        this.destSlot = null;
      }
      exit.push(`  br label %${cleanup.afters[0]![0]}`);
    } else if (cleanup.afters.length > 0 || (hasFallthrough && !fallthroughIsBranchThrough)) {
      const fallback = throughDest ?? (this.unreachable ??= this.newLabel("unreachable"));
      const load = this.t();
      const cases: string[] = [];
      if (source !== null && !fallthroughIsBranchThrough) {
        fallthroughDest = this.newLabel("cleanup.cont");
        if (hasFallthrough) cases.push(`    i32 0, label %${fallthroughDest}`);
      }
      for (const [label, index] of cleanup.afters) cases.push(`    i32 ${index}, label %${label}`);
      exit.push(`  ${load} = load i32, ptr ${this.cleanupDestSlot()}, align 4`);
      exit.push(`  switch i32 ${load}, label %${fallback} [\n${cases.join("\n")}\n  ]`);
    } else exit.push(`  br label %${throughDest!}`);
    this.cleanups.pop();
    this.lifetime("end", cleanup.slot);
    this.cur!.lines.push(...exit);
    if (hasFallthrough && fallthroughDest !== null) this.startBlock(fallthroughDest);
    else if (!hasFallthrough) this.cur = null;
    // A cleanup block with a single predecessor that jumps to it merges
    // into it (SimplifyCleanupEntry).
    const block = this.blocks.find((b) => b.label === entry)!;
    const pred = this.singlePredecessor(block);
    if (pred !== null && new RegExp(`^ {2}br label %${entry}(,|$)`).test(pred.lines.at(-1)!)) {
      pred.lines.pop();
      pred.lines.push(...block.lines);
      this.blocks.splice(this.blocks.indexOf(block), 1);
      if (this.cur === block) this.cur = pred;
    }
  }

  /** clang's `SimplifyForwardingBlocks` for a loop block that only jumps
   * on, when no cleanups are active. */
  private simplifyForwarding(label: string): void {
    if (this.cleanups.length > 0) return;
    const block = this.blocks.find((b) => b.label === label);
    const only =
      block?.lines.length === 1 ? block.lines[0]!.match(/^ {2}br label %([\w.]+)$/) : null;
    if (only === null || only === undefined) return;
    this.blocks.splice(this.blocks.indexOf(block!), 1);
    this.retarget(label, only[1]!);
  }

  private storeSlot(slot: number, value: Value): void {
    const type = this.fn.slots[slot]!.type;
    this.storeTo(this.slotName(slot), type, value, this.align(type));
  }

  private storeTo(pointer: string, type: NativeType, value: Value, align: number): void {
    if (type.kind === "bool") {
      // clang's IRBuilder folds the zext of a constant.
      let z = value.v === "true" ? "1" : value.v === "false" ? "0" : null;
      if (z === null) {
        z = this.t();
        this.emit(`${z} = zext i1 ${value.v} to i8`);
      }
      this.emit(`store i8 ${z}, ptr ${pointer}, align ${align}`);
    } else this.emit(`store ${llType(type)} ${value.v}, ptr ${pointer}, align ${align}`);
  }

  /** A load; optimizing builds mark a boolean's as 0 or 1. */
  private loadFrom(pointer: string, type: NativeType, align: number): Value {
    const r = this.t();
    const range = type.kind === "bool" && this.module.probe.boolLoadRange;
    if (range) this.module.useBoolRange();
    this.emit(
      `${r} = load ${memType(type)}, ptr ${pointer}, align ${align}${range ? `, !range ${BOOL_RANGE}, !noundef ${NOUNDEF}` : ""}`,
    );
    if (type.kind !== "bool") return { ty: llType(type), v: r };
    const b = this.t();
    this.emit(`${b} = trunc i8 ${r} to i1`);
    return { ty: "i1", v: b };
  }

  private statements(body: readonly NativeStmt[]): void {
    for (const s of body) this.statement(s);
  }

  private statement(s: NativeStmt): void {
    // Code after a jump is unreachable, and clang emits none of it, but a
    // declaration in a block there still gets its alloca.
    if (s.kind === "declare") {
      this.declareSlot(s.slot);
      if (this.terminated || this.module.probe.lifetime === null) return;
      this.lifetime("start", s.slot);
      this.cleanups.push({ slot: s.slot, entry: null, branches: new Set(), afters: [] });
      return;
    }
    if (s.kind === "scope") {
      this.scoped(() => this.statements(s.body));
      return;
    }
    if (this.terminated) return;
    switch (s.kind) {
      case "expr":
        this.expr(s.expr);
        return;
      case "store": {
        let v = this.expr(s.value);
        const p = this.expr(s.pointer);
        if (s.op !== undefined)
          v = this.binaryOp(s.op, s.value.type, this.loadFrom(p.v, s.value.type, s.align), v);
        this.storeTo(p.v, s.value.type, v, s.align);
        return;
      }
      case "memset": {
        const p = this.expr(s.pointer);
        const byte = this.expr(s.byte);
        const size = this.expr(s.size);
        let b = byte.v;
        if (s.byte.kind === "const") b = signedLiteral(s.byte.value, 8);
        else {
          b = this.t();
          this.emit(`${b} = trunc i32 ${byte.v} to i8`);
        }
        const bits = this.module.probe.pointerBytes * 8;
        this.module.needIntrinsic(
          `declare void @llvm.memset.p0.i${bits}(ptr, i8, i${bits}, i1 immarg)`,
        );
        this.emit(
          `call void @llvm.memset.p0.i${bits}(ptr align ${s.align} ${p.v}, i8 ${b}, i${bits} ${size.v}, i1 false)`,
        );
        return;
      }
      case "copyToLocal": {
        const source = this.expr(s.source);
        const bits = this.module.probe.pointerBytes * 8;
        this.module.needIntrinsic(
          `declare void @llvm.memcpy.p0.p0.i${bits}(ptr noalias writeonly captures(none), ptr noalias readonly captures(none), i${bits}, i1 immarg)`,
        );
        const type = this.fn.slots[s.slot]!.type;
        this.emit(
          `call void @llvm.memcpy.p0.p0.i${bits}(ptr align ${this.align(type)} ${this.slotName(s.slot)}, ptr align 1 ${source.v}, i${bits} ${s.size}, i1 false)`,
        );
        return;
      }
      case "if": {
        const thenL = this.newLabel("if.then");
        const endL = this.newLabel("if.end");
        const elseL = s.alternative.length > 0 ? this.newLabel("if.else") : endL;
        const c = this.expr(s.condition);
        this.terminate(`br i1 ${c.v}, label %${thenL}, label %${elseL}`);
        this.startBlock(thenL);
        this.scoped(() => this.statements(s.consequent));
        this.branchTo(endL);
        if (elseL !== endL) {
          this.startBlock(elseL);
          this.scoped(() => this.statements(s.alternative));
          this.branchTo(endL);
        }
        this.startBlock(endL, true);
        return;
      }
      case "loop":
        if (s.form === "while") this.whileLoop(s);
        else if (s.form === "do") this.doLoop(s);
        else this.forLoop(s);
        return;
      case "break":
        this.branchThrough(this.loops.at(-1)!.breakDest);
        return;
      case "continue":
        this.branchThrough(this.loops.at(-1)!.continueDest);
        return;
      case "return":
        if (s.value !== null) {
          const v = this.expr(s.value);
          this.emit(
            `store ${this.retvalType()} ${v.v}, ptr %retval, align ${this.align(this.fn.returnType)}`,
          );
        }
        this.branchThrough(this.returnDest);
        return;
    }
  }

  private loopMd(s: LoopStmt): number | null {
    return s.mustProgress ? this.module.loopMetadata() : null;
  }

  /** clang's `EmitWhileStmt`. */
  private whileLoop(s: LoopStmt): void {
    const cond = this.dest("while.cond");
    this.startBlock(cond.label);
    const end = this.dest("while.end");
    this.loops.push({ breakDest: end, continueDest: cond });
    this.scoped(() => {
      this.loopInfo.push({ header: cond.label, md: this.loopMd(s) });
      const body = this.newLabel("while.body");
      if (s.condition !== null)
        this.terminate(`br i1 ${this.expr(s.condition).v}, label %${body}, label %${end.label}`);
      this.scoped(() => {
        this.startBlock(body);
        this.statements(s.body);
      });
      this.loops.pop();
    });
    this.branchTo(cond.label);
    this.loopInfo.pop();
    this.startBlock(end.label, true);
    if (s.condition === null) this.simplifyForwarding(cond.label);
  }

  /** clang's `EmitDoStmt`; a null condition is `true`. */
  private doLoop(s: LoopStmt): void {
    const end = this.dest("do.end");
    const cond = this.dest("do.cond");
    this.loops.push({ breakDest: end, continueDest: cond });
    const body = this.newLabel("do.body");
    this.startBlock(body);
    this.loopInfo.push({ header: body, md: this.loopMd(s) });
    this.scoped(() => this.statements(s.body));
    this.startBlock(cond.label);
    const c = s.condition === null ? "true" : this.expr(s.condition).v;
    this.loops.pop();
    if (c !== "false") this.terminate(`br i1 ${c}, label %${body}, label %${end.label}`);
    this.loopInfo.pop();
    this.startBlock(end.label);
    if (c === "false") this.simplifyForwarding(cond.label);
  }

  /** clang's `EmitForStmt`: the init's locals are in the loop's scope. */
  private forLoop(s: LoopStmt): void {
    const end = this.dest("for.end");
    const forScope = this.cleanups.length;
    this.scoped(() => {
      this.statements(s.init);
      const cond = this.dest("for.cond");
      this.startBlock(cond.label);
      this.loopInfo.push({ header: cond.label, md: this.loopMd(s) });
      this.scoped(() => {
        const next = s.update.length === 0 ? cond : this.dest("for.inc");
        this.loops.push({ breakDest: end, continueDest: next });
        if (s.condition !== null) {
          const exit =
            this.cleanups.length !== forScope ? this.newLabel("for.cond.cleanup") : end.label;
          const body = this.newLabel("for.body");
          const c = this.expr(s.condition);
          this.terminate(`br i1 ${c.v}, label %${body}, label %${exit}`);
          if (exit !== end.label) {
            this.startBlock(exit);
            this.branchThrough(end);
          }
          this.startBlock(body);
        }
        this.scoped(() => this.statements(s.body));
        if (s.update.length > 0) {
          this.startBlock(next.label);
          this.statements(s.update);
        }
        this.loops.pop();
      });
      this.branchTo(cond.label);
    });
    this.loopInfo.pop();
    this.startBlock(end.label, true);
  }

  private expr(e: NativeExpr): Value {
    switch (e.kind) {
      case "const":
        if (e.type.kind === "bool") return { ty: "i1", v: e.value === 0n ? "false" : "true" };
        return { ty: llType(e.type), v: signedLiteral(e.value, (e.type as { bits: number }).bits) };
      case "null":
        return { ty: "ptr", v: "null" };
      case "local": {
        const type = this.fn.slots[e.slot]!.type;
        return this.loadFrom(this.slotName(e.slot), type, this.align(type));
      }
      case "assign": {
        let v = this.expr(e.value);
        if (e.op !== undefined) {
          const type = this.fn.slots[e.slot]!.type;
          const current = this.loadFrom(this.slotName(e.slot), type, this.align(type));
          v = this.binaryOp(e.op, type, current, v);
        }
        this.storeSlot(e.slot, v);
        return v;
      }
      case "step": {
        const type = this.fn.slots[e.slot]!.type as { kind: "int"; bits: number; signed: boolean };
        const old = this.loadFrom(this.slotName(e.slot), e.type, this.align(e.type));
        const r = this.t();
        this.emit(
          `${r} = add${type.signed ? " nsw" : ""} i${type.bits} ${old.v}, ${e.delta === 1n ? 1 : -1}`,
        );
        this.storeSlot(e.slot, { ty: old.ty, v: r });
        return e.postfix ? old : { ty: old.ty, v: r };
      }
      case "binary":
        return this.binary(e);
      case "not": {
        const v = this.expr(e.operand);
        const r = this.t();
        this.emit(`${r} = xor i1 ${v.v}, true`);
        return { ty: "i1", v: r };
      }
      case "complement": {
        const v = this.expr(e.operand);
        const r = this.t();
        this.emit(`${r} = xor ${v.ty} ${v.v}, -1`);
        return { ty: v.ty, v: r };
      }
      case "negate": {
        const v = this.expr(e.operand);
        const r = this.t();
        this.emit(
          `${r} = sub${(e.type as { signed: boolean }).signed ? " nsw" : ""} ${v.ty} 0, ${v.v}`,
        );
        return { ty: v.ty, v: r };
      }
      case "logical": {
        const l = this.expr(e.left);
        const startL = this.currentLabel();
        const rhsL = this.newLabel("land.rhs");
        const endL = this.newLabel("land.end");
        if (e.op === "and") this.terminate(`br i1 ${l.v}, label %${rhsL}, label %${endL}`);
        else this.terminate(`br i1 ${l.v}, label %${endL}, label %${rhsL}`);
        this.startBlock(rhsL);
        const r = this.expr(e.right);
        const rhsEnd = this.currentLabel();
        this.terminate(`br label %${endL}`);
        this.startBlock(endL);
        const p = this.t();
        this.emit(
          `${p} = phi i1 [ ${e.op === "and" ? "false" : "true"}, %${startL} ], [ ${r.v}, %${rhsEnd} ]`,
        );
        return { ty: "i1", v: p };
      }
      case "conditional": {
        const c = this.expr(e.condition);
        const trueL = this.newLabel("cond.true");
        const falseL = this.newLabel("cond.false");
        const endL = this.newLabel("cond.end");
        this.terminate(`br i1 ${c.v}, label %${trueL}, label %${falseL}`);
        this.startBlock(trueL);
        const a = this.expr(e.whenTrue);
        const aEnd = this.currentLabel();
        this.terminate(`br label %${endL}`);
        this.startBlock(falseL);
        const b = this.expr(e.whenFalse);
        const bEnd = this.currentLabel();
        this.terminate(`br label %${endL}`);
        this.startBlock(endL);
        const p = this.t();
        this.emit(`${p} = phi ${a.ty} [ ${a.v}, %${aEnd} ], [ ${b.v}, %${bEnd} ]`);
        return { ty: a.ty, v: p };
      }
      case "convert":
        return this.convert(this.expr(e.operand), e.operand.type, e.type);
      case "offset": {
        const p = this.expr(e.pointer);
        let i = this.expr(e.index);
        const index = e.index.type as { kind: "int"; bits: number; signed: boolean };
        const pointerBits = this.module.probe.pointerBytes * 8;
        if (index.bits !== pointerBits) {
          const w = this.t();
          this.emit(
            `${w} = ${index.signed ? "sext" : "zext"} i${index.bits} ${i.v} to i${pointerBits}`,
          );
          i = { ty: `i${pointerBits}`, v: w };
        }
        const r = this.t();
        this.emit(
          `${r} = getelementptr inbounds${index.signed ? "" : " nuw"} ${memType(e.element)}, ptr ${p.v}, i${pointerBits} ${i.v}`,
        );
        return { ty: "ptr", v: r };
      }
      case "load": {
        const p = this.expr(e.pointer);
        return this.loadFrom(p.v, e.type, e.align);
      }
      case "global": {
        if (!e.threadLocal) return { ty: "ptr", v: `@${e.name}` };
        this.module.needIntrinsic("declare nonnull ptr @llvm.threadlocal.address.p0(ptr nonnull)");
        const r = this.t();
        this.emit(
          `${r} = call align ${e.align} ptr @llvm.threadlocal.address.p0(ptr align ${e.align} @${e.name})`,
        );
        return { ty: "ptr", v: r };
      }
      case "fieldAddress": {
        const base = this.expr(e.base);
        // clang's IRBuilder folds a constant address: the first field is
        // the struct's own address, the others constant expressions.
        if (isConstantAddress(base.v))
          return {
            ty: "ptr",
            v:
              e.index === 0
                ? base.v
                : `getelementptr inbounds nuw (${structType(e.def)}, ptr ${base.v}, i32 0, i32 ${e.index})`,
          };
        const r = this.t();
        this.emit(
          `${r} = getelementptr inbounds nuw ${structType(e.def)}, ptr ${base.v}, i32 0, i32 ${e.index}`,
        );
        return { ty: "ptr", v: r };
      }
      case "elementAddress": {
        const base = this.expr(e.base);
        const i = this.index(e.index);
        const signed = (e.index.type as { signed: boolean }).signed;
        const r = this.t();
        this.emit(
          `${r} = getelementptr inbounds${signed ? "" : " nuw"} [${e.length} x ${memType(e.element)}], ptr ${base.v}, i64 0, ${i.ty} ${i.v}`,
        );
        return { ty: "ptr", v: r };
      }
      case "diff": {
        const bits = this.module.probe.pointerBytes * 8;
        const a = this.expr(e.left);
        const b = this.expr(e.right);
        const ai = this.t();
        const bi = this.t();
        const d = this.t();
        this.emit(`${ai} = ptrtoint ptr ${a.v} to i${bits}`);
        this.emit(`${bi} = ptrtoint ptr ${b.v} to i${bits}`);
        this.emit(`${d} = sub i${bits} ${ai}, ${bi}`);
        if (e.elementSize === 1) return { ty: `i${bits}`, v: d };
        const q = this.t();
        this.emit(`${q} = sdiv exact i${bits} ${d}, ${e.elementSize}`);
        return { ty: `i${bits}`, v: q };
      }
      case "ptrToInt": {
        const v = this.expr(e.operand);
        const r = this.t();
        this.emit(`${r} = ptrtoint ptr ${v.v} to ${llType(e.type)}`);
        return { ty: llType(e.type), v: r };
      }
      case "intToPtr": {
        const v = this.expr(e.operand);
        const r = this.t();
        this.emit(`${r} = inttoptr ${v.ty} ${v.v} to ptr`);
        return { ty: "ptr", v: r };
      }
      case "call":
        return this.call(e);
      case "expect": {
        const v = this.expr(e.operand);
        this.module.needIntrinsic("declare i1 @llvm.expect.i1(i1, i1)");
        const r = this.t();
        this.emit(`${r} = call i1 @llvm.expect.i1(i1 ${v.v}, i1 ${e.expected ? "true" : "false"})`);
        return { ty: "i1", v: r };
      }
    }
  }

  /** An index widened to the pointer width, as C converts array subscripts. */
  private index(e: NativeExpr): Value {
    const v = this.expr(e);
    const index = e.type as { bits: number; signed: boolean };
    const bits = this.module.probe.pointerBytes * 8;
    if (index.bits === bits) return v;
    const w = this.t();
    this.emit(`${w} = ${index.signed ? "sext" : "zext"} i${index.bits} ${v.v} to i${bits}`);
    return { ty: `i${bits}`, v: w };
  }

  private currentLabel(): string {
    return this.cur!.label;
  }

  private convert(v: Value, from: NativeType, to: NativeType): Value {
    const toTy = llType(to);
    if (from.kind === "bool") {
      const r = this.t();
      this.emit(`${r} = zext i1 ${v.v} to ${toTy}`);
      return { ty: toTy, v: r };
    }
    const fromBits = (from as { bits: number }).bits;
    const toBits = (to as { bits: number }).bits;
    if (fromBits === toBits) return { ty: toTy, v: v.v };
    const r = this.t();
    const op = toBits < fromBits ? "trunc" : (from as { signed: boolean }).signed ? "sext" : "zext";
    this.emit(`${r} = ${op} ${v.ty} ${v.v} to ${toTy}`);
    return { ty: toTy, v: r };
  }

  private binary(e: Extract<NativeExpr, { kind: "binary" }>): Value {
    const a = this.expr(e.left);
    const b = this.expr(e.right);
    return this.binaryOp(e.op, e.left.type, a, b);
  }

  private binaryOp(op: NativeBinaryOp, operand: NativeType, a: Value, b: Value): Value {
    const signed = operand.kind === "int" && operand.signed;
    const r = this.t();
    const cmp: Record<string, string> = {
      eq: "eq",
      ne: "ne",
      lt: signed ? "slt" : "ult",
      le: signed ? "sle" : "ule",
      gt: signed ? "sgt" : "ugt",
      ge: signed ? "sge" : "uge",
    };
    if (op in cmp) {
      this.emit(`${r} = icmp ${cmp[op]} ${a.ty} ${a.v}, ${b.v}`);
      return { ty: "i1", v: r };
    }
    const nsw = signed ? " nsw" : "";
    const ops: Record<string, string> = {
      add: `add${nsw}`,
      sub: `sub${nsw}`,
      mul: `mul${nsw}`,
      div: signed ? "sdiv" : "udiv",
      rem: signed ? "srem" : "urem",
      and: "and",
      or: "or",
      xor: "xor",
      shl: "shl",
      shr: signed ? "ashr" : "lshr",
    };
    this.emit(`${r} = ${ops[op]} ${a.ty} ${a.v}, ${b.v}`);
    return { ty: a.ty, v: r };
  }

  private call(e: Extract<NativeExpr, { kind: "call" }>): Value {
    const probe = this.module.probe;
    this.references.push(`@${e.callee}`);
    const args = e.args.map((arg) => {
      const v = this.expr(arg);
      const attrs = probe.paramAttributes.get(abiKey(arg.type)!) ?? "noundef";
      return `${v.ty}${attrs ? ` ${attrs}` : ""} ${v.v}`;
    });
    const key = abiKey(e.type);
    const retAttrs = key === null ? "" : (probe.returnAttributes.get(key) ?? "");
    const callAttrs = this.module.callAttributes(e.callee);
    const text = `call ${retAttrs ? `${retAttrs} ` : ""}${llType(e.type)} @${e.callee}(${args.join(", ")})${callAttrs}`;
    this.calleeNoted = e.callee;
    if (e.type.kind === "void") {
      this.emit(text);
      return { ty: "void", v: "" };
    }
    const r = this.t();
    this.emit(`${r} = ${text}`);
    return { ty: llType(e.type), v: r };
  }
}

/** Attribute groups, metadata and declarations shared by a module's functions. */
class ModuleEmitter {
  readonly attributeGroups: string[] = [];
  private readonly groupIds = new Map<string, number>();
  readonly loopNodes: number[] = [];
  readonly intrinsics = new Set<string>();
  private boolRange = false;

  constructor(
    readonly probe: NativeProbe,
    private readonly module: NativeModule,
    private readonly firstGroup: number,
    private readonly firstMetadata: number,
    /** The metadata nodes of the unit merged into, by their text. */
    private readonly unitNodes: ReadonlyMap<string, number> = new Map(),
  ) {}

  useBoolRange(): void {
    this.boolRange = true;
  }

  group(text: string): number {
    let id = this.groupIds.get(text);
    if (id === undefined) {
      id = this.firstGroup + this.attributeGroups.length;
      this.attributeGroups.push(text);
      this.groupIds.set(text, id);
    }
    return id;
  }

  /** A fresh `distinct` loop node; the shared mustprogress node follows them all. */
  loopMetadata(): number {
    const id = this.firstMetadata + 1 + this.loopNodes.length;
    this.loopNodes.push(id);
    return id;
  }

  needIntrinsic(declaration: string): void {
    this.intrinsics.add(declaration);
  }

  callAttributes(callee: string): string {
    const libc = this.probe.libc.get(callee);
    const ext = this.module.externs.find((x) => x.name === callee);
    if (ext?.builtin === true && libc?.callAttributes)
      return ` #${this.group(libc.callAttributes)}`;
    return "";
  }

  functionGroup(fn: NativeFunction): number {
    const has = (a: string): boolean => fn.attributes.includes(a as never);
    let base = has("inline") ? this.probe.inlineAttributes : this.probe.plainAttributes;
    const extra: string[] = [];
    if (has("alwaysInline")) extra.push("alwaysinline");
    if (has("noinline")) extra.push("noinline");
    if (has("cold")) extra.push("cold");
    if (extra.length > 0) base = `${extra.join(" ")} ${base}`;
    return this.group(base);
  }

  externDeclarations(skip: (name: string) => boolean): string[] {
    const out: string[] = [];
    for (const ext of this.module.externs) {
      if (skip(ext.name)) continue;
      const libc = ext.builtin ? this.probe.libc.get(ext.name) : undefined;
      if (libc !== undefined) {
        out.push(`${libc.declaration} #${this.group(libc.declarationAttributes)}`);
        continue;
      }
      const params = ext.params.map((p) => {
        const attrs = this.probe.paramAttributes.get(abiKey(p)!) ?? "noundef";
        return `${llType(p)}${attrs ? ` ${attrs}` : ""}`;
      });
      const key = abiKey(ext.returnType);
      const ret = key === null ? "" : (this.probe.returnAttributes.get(key) ?? "");
      out.push(
        `declare ${ret ? `${ret} ` : ""}${llType(ext.returnType)} @${ext.name}(${params.join(", ")})`,
      );
    }
    return out;
  }

  structDefinitions(): string[] {
    return this.module.structs.map((def) => `${structType(def)} = type ${structBody(def)}`);
  }

  globalDeclarations(skip: (name: string) => boolean): string[] {
    const prefix = (p: string): string => (p === "" ? "" : `${p} `);
    return this.module.globals
      .filter((g) => !skip(g.symbol))
      .map(
        (g) =>
          `@${g.symbol} = external ${prefix(g.threadLocal ? this.probe.externalThreadLocalPrefix : this.probe.externalGlobalPrefix)}global ${memType(g.type)}, align ${g.align}`,
      );
  }

  /** The module's metadata nodes: the loop nodes, then the boolean load
   * nodes the unit merged into lacks; and `resolve`, which numbers the
   * boolean load stand-ins in function text. */
  metadata(): { lines: string[]; resolve(text: string): string } {
    const lines: string[] = [];
    let next = this.firstMetadata;
    if (this.loopNodes.length > 0) {
      const progress = next;
      lines.push(
        `!${progress} = !{!"llvm.loop.mustprogress"}`,
        ...this.loopNodes.map((id) => `!${id} = distinct !{!${id}, !${progress}}`),
      );
      next += 1 + this.loopNodes.length;
    }
    const ids = new Map<string, string>();
    if (this.boolRange)
      for (const [standIn, body] of [
        [BOOL_RANGE, "!{i8 0, i8 2}"],
        [NOUNDEF, "!{}"],
      ] as const) {
        let id = this.unitNodes.get(body);
        if (id === undefined) {
          id = next++;
          lines.push(`!${id} = ${body}`);
        }
        ids.set(standIn, `!${id}`);
      }
    return {
      lines,
      resolve: (text) => {
        for (const [standIn, id] of ids) text = text.replaceAll(standIn, id);
        return text;
      },
    };
  }
}

function emitFunctions(
  module: NativeModule,
  emitter: ModuleEmitter,
  linkage: (fn: NativeFunction) => string,
): string[] {
  return module.functions.map((fn) =>
    new FunctionEmitter(fn, emitter).run(linkage(fn), emitter.functionGroup(fn)),
  );
}

/** A standalone module: exported functions are external, others internal. */
export function emitNativeModule(
  module: NativeModule,
  probe: NativeProbe,
  sourceName: string,
): string {
  const metadataStart = probe.moduleMetadata.filter(
    (l) => l.startsWith("!") && /^!\d/.test(l),
  ).length;
  const emitter = new ModuleEmitter(probe, module, 0, metadataStart);
  const functions = emitFunctions(module, emitter, (fn) =>
    fn.exported ? probe.definitionPrefix : "internal",
  );
  const declarations = [...emitter.externDeclarations(() => false), ...emitter.intrinsics];
  const metadata = emitter.metadata();
  return metadata.resolve(
    [
      `; ModuleID = '${sourceName}'`,
      `source_filename = "${sourceName}"`,
      `target datalayout = "${probe.dataLayout}"`,
      `target triple = "${probe.triple}"`,
      "",
      ...emitter.structDefinitions(),
      "",
      ...emitter.globalDeclarations(() => false),
      "",
      ...functions.flatMap((f) => [f, ""]),
      ...declarations,
      "",
      ...emitter.attributeGroups.map((g, i) => `attributes #${i} = { ${g} }`),
      "",
      ...probe.moduleMetadata,
      ...metadata.lines,
      "",
    ].join("\n"),
  );
}

/** `unit`, a C unit's frontend IR compiled with the stand-in bodies of
 * `nativeShapes`, with the module's functions in place of the stand-ins.
 * clang placed and ordered the stand-ins, and every use they make, as it
 * does the C definitions, so the result is the unit's IR from the C
 * definitions when the native code matches them, use-list order included
 * (`-emit-llvm-uselists`). Types, globals and declarations the native code
 * needs and the unit lacks are added. */
export function mergeNativeModule(module: NativeModule, probe: NativeProbe, unit: string): string {
  const maxGroup = Math.max(
    -1,
    ...[...unit.matchAll(/^attributes #(\d+) =/gm)].map((m) => Number(m[1])),
  );
  const maxMetadata = Math.max(-1, ...[...unit.matchAll(/^!(\d+) =/gm)].map((m) => Number(m[1])));
  const unitNodes = new Map<string, number>();
  for (const m of unit.matchAll(/^!(\d+) = (.*)$/gm)) unitNodes.set(m[2]!, Number(m[1]));
  const emitter = new ModuleEmitter(probe, module, maxGroup + 1, maxMetadata + 1, unitNodes);
  const byName = new Map(module.functions.map((f) => [f.name, f]));
  const lines = unit.split("\n");
  const body: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const m = line.match(/^(define|declare) [^@]*@([\w.$]+)\(/);
    const fn = m === null ? undefined : byName.get(m[2]!);
    if (fn === undefined) {
      body.push(line);
      continue;
    }
    if (m![1] === "declare")
      throw new Error(
        `the C unit declares ${fn.name} from ${module.file}: compile it with the stand-in bodies (nativeShapes)`,
      );
    while (lines[i] !== "}") i++;
    body.push(new FunctionEmitter(fn, emitter).run("internal", emitter.functionGroup(fn)));
  }
  const has = (pattern: RegExp): boolean => body.some((line) => pattern.test(line));
  const escape = (name: string): string => name.replace(/[.$]/g, "\\$&");
  const declaredInUnit = (name: string): boolean =>
    has(new RegExp(`^(declare|define) [^@]*@${escape(name)}\\(`));
  // Struct types: the unit's own when it has the same type, else ours.
  const types: string[] = [];
  for (const def of module.structs) {
    const name = structType(def);
    const ours = `${name} = type ${structBody(def)}`;
    const theirs = body.find((line) => line.startsWith(`${name} = type `));
    if (theirs === undefined) types.push(ours);
    else if (theirs !== ours)
      throw new Error(
        `${name} in ${module.file} is ${structBody(def)}, but the C unit has ${theirs}`,
      );
  }
  const globals = emitter.globalDeclarations((symbol) => has(new RegExp(`^@${escape(symbol)} = `)));
  const declarations = [
    ...emitter.externDeclarations(declaredInUnit),
    ...[...emitter.intrinsics].filter((d) => !declaredInUnit(d.match(/@([\w.]+)\(/)![1]!)),
  ];
  // Types and globals after the unit's; declarations before its attribute
  // groups; ours and the loop metadata at the end.
  const firstFunction = body.findIndex((line) => /^(define|declare) /.test(line));
  const firstAttribute = body.findIndex((line) => line.startsWith("attributes #"));
  const head = body.slice(0, firstFunction === -1 ? body.length : firstFunction);
  const middle = body.slice(head.length, firstAttribute === -1 ? body.length : firstAttribute);
  const tail = firstAttribute === -1 ? [] : body.slice(firstAttribute);
  const metadata = emitter.metadata();
  return metadata.resolve(
    [
      ...head,
      ...types,
      ...globals,
      ...(types.length + globals.length > 0 ? [""] : []),
      ...middle,
      ...declarations,
      "",
      ...tail,
      ...emitter.attributeGroups.map((g, i) => `attributes #${maxGroup + 1 + i} = { ${g} }`),
      ...metadata.lines,
      "",
    ].join("\n"),
  );
}

/** The structs a module's code uses: those of its globals, parameters,
 * locals and returns, and the structs those embed or point to. */
function usedStructs(module: NativeModule): NativeStruct[] {
  const used = new Set<NativeStruct>();
  const visit = (t: NativeMemType): void => {
    if (t.kind === "ref" || t.kind === "inline") {
      if (used.has(t.def)) return;
      used.add(t.def);
      for (const f of t.def.fields) visit(f.type);
    } else if (t.kind === "array" || t.kind === "arrayref") visit(t.element);
    else if (t.kind === "ptr" && t.to !== null) visit(t.to);
  };
  for (const g of module.globals) visit(g.type);
  for (const fn of module.functions) {
    for (const slot of fn.slots) visit(slot.type);
    visit(fn.returnType);
  }
  return module.structs.filter((def) => used.has(def));
}

/** C `_Static_assert`s that each struct interface the module uses and that
 * names its C twin (`CStruct<"Name">`) has that struct's size, alignment
 * and field offsets. Compiled next to the C headers, they fail the build
 * when the two layouts drift apart. */
export function nativeLayoutAsserts(module: NativeModule): string {
  const lines = [
    "/* Layouts of the native unit's struct interfaces (scriptc native-unit). */",
    "#include <stddef.h>",
  ];
  for (const def of usedStructs(module)) {
    if (def.cName === null) continue;
    const c = def.cName;
    const why = `"${def.name} in ${module.file.split("/").pop()} does not match ${c}"`;
    lines.push(`_Static_assert(sizeof(${c}) == ${def.size}, ${why});`);
    lines.push(`_Static_assert(_Alignof(${c}) == ${def.align}, ${why});`);
    for (const f of def.fields)
      lines.push(`_Static_assert(offsetof(${c}, ${f.name}) == ${f.offset}, ${why});`);
  }
  return lines.join("\n") + "\n";
}

/** Stand-in C bodies for the module's functions, one macro each
 * (`SCR_NATIVE_SHAPE_<name>`), for the header that declares the functions
 * to define them with in a native build.
 *
 * clang orders a unit by when it creates functions and globals and in
 * what order it creates the uses of each one, and the backend's results
 * depend on both: a `static inline` function is emitted after the unit's
 * own functions, in the order the unit first used them, and its uses of a
 * global or of a function come at that point in the global's list of
 * uses. A stand-in body makes the same references as the native code, in
 * the same order and as many times: a volatile load from the address of a
 * function for each call (a call to a C library function with constant
 * arguments could fold away), and of a global or a constant field address
 * for each use, a block with a local for each local's lifetime, and a
 * memset or memcpy for each.
 * Compiled with the stand-ins, the unit's frontend IR (with its use-list
 * order, `-emit-llvm-uselists`) is the C build's but for their bodies,
 * which `mergeNativeModule` replaces with the native ones. */
export function nativeShapes(module: NativeModule, probe: NativeProbe): string {
  const emitter = new ModuleEmitter(probe, module, 0, 0);
  const functions = new Set([...module.functions, ...module.externs].map((f) => f.name));
  const globals = new Set(module.globals.map((g) => g.symbol));
  const structs = new Map(module.structs.map((s) => [`%struct.${s.cName}`, s]));
  const lines = [
    `/* Stand-in bodies for ${module.file.split("/").pop()} (scriptc native-unit --shapes). */`,
  ];
  for (const fn of module.functions) {
    const emitted = new FunctionEmitter(fn, emitter);
    const body = emitted.run("internal", 0);
    const fail = (what: string): never => {
      throw new Error(`${fn.name} in ${module.file}: no stand-in for ${what}`);
    };
    const out: string[] = [];
    let locals = 0;
    let open = 0;
    let fieldAddresses = 0;
    for (const reference of emitted.references) {
      const m = reference.match(new RegExp(`^(?:${OUTSIDE_REFERENCE.source})$`))!;
      const [, lifetime, memory, threadLocal, struct, base, field, name] = m;
      if (lifetime === "start") {
        out.push(`{ __attribute__((unused)) char scr_native_local${locals++};`);
        open++;
      } else if (lifetime === "end") {
        if (open-- === 0) fail("a lifetime that ends before it starts");
        out.push("}");
      } else if (memory !== undefined)
        out.push(
          memory === "memset"
            ? "__builtin_memset((void *)0, 0, 0);"
            : "__builtin_memcpy((void *)0, (const void *)0, 0);",
        );
      else if (threadLocal !== undefined) out.push(`(void)*(volatile char *)&${threadLocal};`);
      else if (struct !== undefined) {
        fieldAddresses++;
        const def = structs.get(struct) ?? fail(`a field of ${struct}`);
        const f = def.fields[Number(field)] ?? fail(`field ${field} of ${struct}`);
        out.push(`(void)*(volatile char *)&${base}.${f.name};`);
      } else if (name!.startsWith("llvm.")) fail(`@${name}`);
      else if (globals.has(name!) || functions.has(name!))
        out.push(`(void)*(volatile char *)&${name};`);
      else fail(`@${name}`);
    }
    if (body.split("getelementptr inbounds nuw (").length - 1 !== fieldAddresses)
      fail("a nested constant address");
    if (open !== 0) fail("a lifetime that does not end");
    if (fn.returnType.kind !== "void") out.push("return 0;");
    lines.push(
      `#define SCR_NATIVE_SHAPE_${fn.name} { _Pragma("clang diagnostic push") _Pragma("clang diagnostic ignored \\"-Wnonnull\\"") ${out.join(" ")} _Pragma("clang diagnostic pop") }`,
    );
  }
  return lines.join("\n") + "\n";
}

/** The counter clang's module ended its frontend with, for the names it
 * made unique: LLVM gives a global whose name is taken the next value of
 * one counter per module (`.str.7`), and the passes that later name new
 * globals (a switch's lookup table, `switch.table.f.667`) continue it. A
 * module parsed from text starts the counter at zero, so the frontend IR
 * of a unit, with the native code in place of its stand-ins, would name
 * those globals differently. The counter is the largest such suffix in the
 * frontend IR.
 *
 * `counter` is a module to link into the unit with clang's
 * `-mlink-builtin-bitcode`, and `declarations` the lines it links against:
 * linking a definition in place of a declaration takes two values of the
 * counter, and each of its internal functions that takes a name the unit
 * has, one. All of it is unused, and the optimizer removes it before code
 * generation. Null when the counter is 0, or 1, which no link takes, and
 * in builds without optimization (`optnone`), whose passes name nothing
 * and keep unused code. */
export function nameCounter(
  unit: string,
  probe: NativeProbe,
): { counter: string; declarations: string[] } | null {
  if (/\boptnone\b/.test(probe.plainAttributes)) return null;
  let count = 0;
  for (const m of unit.matchAll(/^(?:@|(?:define|declare) [^@]*@)[\w.$]+?\.(\d+)(?: = |\()/gm))
    count = Math.max(count, Number(m[1]));
  if (count < 2) return null;
  const slots = Array.from({ length: count - 2 }, (_, i) => `scr.native.counter.slot${i}`);
  return {
    counter: [
      `target datalayout = "${probe.dataLayout}"`,
      `target triple = "${probe.triple}"`,
      "",
      "define void @scr.native.counter() {",
      ...slots.map((s) => `  call void @${s}()`),
      "  ret void",
      "}",
      ...slots.map((s) => `define internal void @${s}() {\n  ret void\n}`),
      "",
    ].join("\n"),
    declarations: [
      "declare void @scr.native.counter()",
      ...slots.map((s) => `@${s} = external global i8`),
    ],
  };
}

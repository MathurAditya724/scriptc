/* Per-type publication walkers (@scriptc/threads publish).
 *
 * publish(root) hands the root and its static type's walker to the
 * runtime's scr_publish (scr_cycle.c), which runs a worklist. A walker
 * marks its object immortal (scr_pub_mark answers false when it already
 * was: the walk's visited test, so shared and cyclic structure is walked
 * once) and pushes every reference it holds, each with the walker of its
 * static type. Hierarchy members dispatch on the object's concrete class
 * (its vtable's preorder number) because a base-typed field may hold any
 * subclass. Strings, bigints, arrays, maps, sets and dyn values use runtime
 * walkers; arrays and maps receive the element, key and value walkers.
 *
 * Publishable values are those Node's structured clone accepts and that
 * hold no mutable native state: numbers, booleans, strings, bigints,
 * undefined and null, class instances, records, arrays, maps and sets of
 * publishable values, and plain dyn data. Static types over-approximate
 * what a graph holds (a base-typed `parent` field statically reaches every
 * subclass), so an unpublishable type — functions, promises, symbols,
 * regexes, dates, typed arrays, native handles, runtime-rooted classes
 * (errors, emitters, streams) — gets a refusing walker: publishing fails
 * with the Node.js implementation's TypeError only when such a value is
 * actually present, and the whole publish is then undone. With
 * SCRIPTC_PUBLISH_TRACE set, the runtime also prints the static path. */
import type { IrClassDef, IrRecordShape, IrType, IrUnionDef, SrcLoc } from "../../ir/ir.js";
import { mapOf, STRING, typeKey } from "../../ir/ir.js";
import { mangleClassStruct, mangleRecordStruct } from "../mangle.js";
import { FN_ATTRS } from "./shapes.js";
import type { InlineUnionFields } from "./inline-unions.js";
import { LlvmUnsupportedError } from "./unsupported.js";

export interface PublishHost {
  declare(decl: string): void;
  /** An interned NUL-terminated constant. */
  cstr(text: string): string;
  readonly sizeType: "i32" | "i64";
  readonly tracedShapes: ReadonlySet<string>;
  readonly unionsById: ReadonlyMap<string, IrUnionDef>;
  readonly recordsById: ReadonlyMap<string, IrRecordShape>;
  /** Record fields that store a scalar union inline: plain bits, nothing
   * to push. */
  readonly inlineUnions: InlineUnionFields;
  /** The nullable-pointer representation of a union, when it has one. */
  nullableArm(t: IrType): IrType | null;
  /** Class layout: hierarchy membership, preorder interval, field slots
   * (with their storage types), runtime roots. */
  classInfo(className: string): PublishClassInfo;
  /** Every class whose preorder number lies in [pre, post]. */
  classesInInterval(pre: number, post: number): string[];
}

export interface PublishClassInfo {
  def: IrClassDef;
  hierarchy: boolean;
  pre: number;
  post: number;
  /** A runtime-provided root class (errors, emitters, streams). */
  runtimeRooted: boolean;
  /** The class's own and inherited fields: GEP index and storage type. */
  fields: { name: string; index: number; type: IrType }[];
}

/** scr_pub_mark's object kinds (SCR_PUB_KIND_* in scr_runtime.h), for the RC audit. */
const PUB_KIND_OBJECT = 4;
const PUB_KIND_UNION = 5;

const RUNTIME_WALKERS = {
  string: "@scr_pub_str_fn",
  bigint: "@scr_pub_leaf_fn",
  dyn: "@scr_pub_dyn_fn",
} as const;

export class PublishWalkers {
  private readonly walkers = new Map<string, string | null>();
  private readonly defsOut: string[] = [];
  private counter = 0;

  constructor(private readonly host: PublishHost) {}

  /** The definitions emitted so far (module-level LLVM text). */
  defs(): string[] {
    return this.defsOut;
  }

  /** Lines publishing the value `v` (an LLVM ptr of static type `t`), or
   * none for types that hold no references. */
  emitPublish(v: string, t: IrType, loc: SrcLoc): string[] {
    const root = this.host.nullableArm(t) ?? t;
    if (scalarRefusal(root)) {
      // A Date (or process stream) is a scalar here, but Node.js refuses it.
      this.host.declare(`declare void @scr_publish_refuse(ptr)`);
      return [`  call void @scr_publish_refuse(ptr ${this.host.cstr(refusalMessage(root))})`];
    }
    const fn = this.walker(t, "the published value", loc);
    if (fn === null) return [];
    this.host.declare(`declare void @scr_publish(ptr, ptr)`);
    return [`  call void @scr_publish(ptr ${v}, ptr ${fn})`];
  }

  /** The walker symbol for values of type `t` (null: nothing to walk). */
  walker(t: IrType, path: string, loc: SrcLoc): string | null {
    const arm = this.host.nullableArm(t);
    if (arm !== null) return this.walker(arm, path, loc);
    switch (t.kind) {
      case "f64":
      case "bool":
      case "undefinedT":
      case "nullT":
      case "void":
        return null;
      case "string":
      case "bigint":
      case "dyn": {
        const sym = RUNTIME_WALKERS[t.kind];
        this.host.declare(`declare void ${sym}(ptr, ptr)`);
        return sym;
      }
      case "object":
      case "record":
      case "array":
      case "map":
      case "set":
      case "union":
        break;
      default:
        return this.refusal(refusalMessage(t), `${typeKey(t)} at ${path}`);
    }
    const key = typeKey(t);
    const known = this.walkers.get(key);
    if (known !== undefined) return known;
    const sym = `@sc_pub_${this.counter++}`;
    this.walkers.set(key, sym);
    const body = this.body(t, sym, path, loc);
    this.defsOut.push(...body, ``);
    return sym;
  }

  private readonly refusals = new Map<string, string>();

  /** A walker that refuses the publish when a value is actually present:
   * the Node.js implementation's TypeError, plus the static path for
   * SCRIPTC_PUBLISH_TRACE. */
  private refusal(message: string, detail: string): string {
    const key = `${message}\0${detail}`;
    const known = this.refusals.get(key);
    if (known !== undefined) return known;
    const sym = `@sc_pub_${this.counter++}`;
    this.refusals.set(key, sym);
    this.host.declare(`declare void @scr_pub_refuse_at(ptr, ptr, ptr)`);
    this.defsOut.push(
      `define internal void ${sym}(ptr %o, ptr %ctx) ${FN_ATTRS} { ; refuse ${llvmComment(detail)}`,
      `entry:`,
      `  call void @scr_pub_refuse_at(ptr %ctx, ptr ${this.host.cstr(message)}, ptr ${this.host.cstr(detail)})`,
      `  ret void`,
      `}`,
      ``,
    );
    return sym;
  }

  private declareRuntime(): void {
    this.host.declare(`declare zeroext i1 @scr_pub_mark(ptr, ptr, i1 zeroext, i32)`);
    this.host.declare(`declare void @scr_pub_push(ptr, ptr, ptr)`);
  }

  /** `define` lines for the walker `sym` of `t`. */
  private body(t: IrType, sym: string, path: string, loc: SrcLoc): string[] {
    this.declareRuntime();
    const head = `define internal void ${sym}(ptr %o, ptr %ctx) ${FN_ATTRS} { ; publish ${llvmComment(typeKey(t))}`;
    switch (t.kind) {
      case "array": {
        const elem = this.walker(t.elem, `${path}[element]`, loc);
        if (scalarRefusal(t.elem)) throw new LlvmUnsupportedError(`publish of ${typeKey(t)}`, loc);
        this.host.declare(`declare void @scr_pub_arr(ptr, ptr, ptr)`);
        return [
          head,
          `entry:`,
          `  call void @scr_pub_arr(ptr %o, ptr %ctx, ptr ${elem ?? "null"})`,
          `  ret void`,
          `}`,
        ];
      }
      case "map":
      case "set": {
        const keyType = t.kind === "map" ? t.key : t.elem;
        const k = this.walker(keyType, `${path}[key]`, loc);
        const v = t.kind === "map" ? this.walker(t.value, `${path}[value]`, loc) : null;
        if (scalarRefusal(keyType) || (t.kind === "map" && scalarRefusal(t.value)))
          throw new LlvmUnsupportedError(`publish of ${typeKey(t)}`, loc);
        this.host.declare(`declare void @scr_pub_map(ptr, ptr, ptr, ptr)`);
        return [
          head,
          `entry:`,
          `  call void @scr_pub_map(ptr %o, ptr %ctx, ptr ${k ?? "null"}, ptr ${v ?? "null"})`,
          `  ret void`,
          `}`,
        ];
      }
      case "union": {
        const def = this.host.unionsById.get(t.unionId);
        if (!def) throw new LlvmUnsupportedError(`publish of an unknown union ${t.unionId}`, loc);
        const arms = def.arms.map((arm, tag) => ({
          tag,
          fn: this.walker(arm, `${path} (as ${typeKey(arm)})`, loc),
        }));
        // Union arms are boxed pointers or plain scalars; a date arm would
        // hold time-value bits that no walker may push.
        if (def.arms.some((arm) => scalarRefusal(arm)))
          throw new LlvmUnsupportedError(`publish of ${typeKey(t)}`, loc);
        const live = arms.flatMap((a) => (a.fn === null ? [] : [{ tag: a.tag, fn: a.fn }]));
        const lines = [
          head,
          `entry:`,
          // Union boxes always carry a collector header (scr_union_release).
          `  %m = call zeroext i1 @scr_pub_mark(ptr %ctx, ptr %o, i1 true, i32 ${PUB_KIND_UNION})`,
          `  br i1 %m, label %walk, label %done`,
          `walk:`,
        ];
        if (live.length === 0) lines.push(`  br label %done`);
        else {
          lines.push(
            `  %tagp = getelementptr inbounds %ScrUnion, ptr %o, i64 0, i32 1`,
            `  %tag = load i32, ptr %tagp`,
            `  %slotp = getelementptr inbounds %ScrUnion, ptr %o, i64 0, i32 5`,
            `  %slot = load ptr, ptr %slotp`,
            `  switch i32 %tag, label %done [ ${live.map((a) => `i32 ${a.tag}, label %arm${a.tag}`).join(" ")} ]`,
          );
          for (const a of live)
            lines.push(
              `arm${a.tag}:`,
              ...this.push("%slot", a.fn, `u${a.tag}`),
              `  br label %done`,
            );
        }
        lines.push(`done:`, `  ret void`, `}`);
        return lines;
      }
      case "record": {
        const shape = this.host.recordsById.get(t.shapeId);
        if (!shape)
          throw new LlvmUnsupportedError(`publish of an unknown record ${t.shapeId}`, loc);
        const members = [
          ...shape.fields.flatMap((f, i) =>
            this.host.inlineUnions.record(f.type)
              ? []
              : [{ name: f.name, index: i + 1, type: f.type }],
          ),
          ...(shape.indexValue
            ? [
                {
                  name: "[key: string]",
                  index: shape.fields.length + 1,
                  type: mapOf(STRING, shape.indexValue),
                },
              ]
            : []),
        ];
        return this.objectBody(
          head,
          mangleRecordStruct(shape.id),
          this.host.tracedShapes.has(`record:${shape.id}`),
          members,
          path,
          loc,
        );
      }
      case "object":
        return this.classBody(t.className, head, path, loc);
      default:
        throw new LlvmUnsupportedError(`publish of ${typeKey(t)}`, loc);
    }
  }

  /** A class walker: the class itself, or a dispatch over every class of
   * its subtree when it belongs to a hierarchy. */
  private classBody(className: string, head: string, path: string, loc: SrcLoc): string[] {
    const info = this.host.classInfo(className);
    if (!info.hierarchy) return this.concreteClassBody(info, head, path, loc);
    const members = this.host.classesInInterval(info.pre, info.post);
    const cases = members.map((name) => {
      const sub = this.host.classInfo(name);
      const sym = `@sc_pub_${this.counter++}`;
      const subHead = `define internal void ${sym}(ptr %o, ptr %ctx) ${FN_ATTRS} { ; publish class ${llvmComment(name)}`;
      this.defsOut.push(...this.concreteClassBody(sub, subHead, `${path} (a ${name})`, loc), ``);
      return { pre: sub.pre, sym, name };
    });
    const lines = [
      head,
      `entry:`,
      `  %vtp = getelementptr inbounds ptr, ptr %o, i64 1`,
      `  %vt = load ptr, ptr %vtp`,
      `  %pre = load ${this.host.sizeType}, ptr %vt`,
      `  switch ${this.host.sizeType} %pre, label %other [ ${cases.map((c) => `${this.host.sizeType} ${c.pre}, label %c${c.pre}`).join(" ")} ]`,
    ];
    for (const c of cases)
      lines.push(
        `c${c.pre}: ; ${llvmComment(c.name)}`,
        `  call void ${c.sym}(ptr %o, ptr %ctx)`,
        `  ret void`,
      );
    lines.push(`other:`, `  unreachable`, `}`);
    return lines;
  }

  private concreteClassBody(
    info: PublishClassInfo,
    head: string,
    path: string,
    loc: SrcLoc,
  ): string[] {
    if (info.runtimeRooted) {
      const refuse = this.refusal(
        info.def.name === "%Error" || info.def.base !== undefined
          ? "Cannot publish a Error object"
          : "Cannot publish this value",
        `${info.def.name} at ${path}`,
      );
      return [head, `entry:`, `  call void ${refuse}(ptr %o, ptr %ctx)`, `  ret void`, `}`];
    }
    return this.objectBody(
      head,
      mangleClassStruct(info.def.name),
      this.host.tracedShapes.has(`object:${info.def.name}`),
      info.fields,
      path,
      loc,
    );
  }

  /** Lines pushing the reference `v` with the walker `fn`. Null and
   * immortal references (the parent links of a tree, values published
   * before) are the ones scr_pub_push skips: they are tested here, without
   * the call. The lines end in a fresh block labelled `pushed${id}`. */
  private push(v: string, fn: string, id: string): string[] {
    const size = this.host.sizeType;
    return [
      `  %null${id} = icmp eq ptr ${v}, null`,
      `  br i1 %null${id}, label %pushed${id}, label %live${id}`,
      `live${id}:`,
      `  %rc${id} = load ${size}, ptr ${v}`,
      `  %immortal${id} = icmp eq ${size} %rc${id}, -1`,
      `  br i1 %immortal${id}, label %pushed${id}, label %push${id}`,
      `push${id}:`,
      `  call void @scr_pub_push(ptr %ctx, ptr ${v}, ptr ${fn})`,
      `  br label %pushed${id}`,
      `pushed${id}:`,
    ];
  }

  private objectBody(
    head: string,
    struct: string,
    traced: boolean,
    members: { name: string; index: number; type: IrType }[],
    path: string,
    loc: SrcLoc,
  ): string[] {
    const lines = [
      head,
      `entry:`,
      `  %m = call zeroext i1 @scr_pub_mark(ptr %ctx, ptr %o, i1 ${traced ? "true" : "false"}, i32 ${PUB_KIND_OBJECT})`,
      `  br i1 %m, label %walk, label %done`,
      `walk:`,
    ];
    let n = 0;
    for (const member of members) {
      const fn = this.walker(member.type, `${path}.${member.name}`, loc);
      if (fn === null) continue;
      if (scalarRefusal(member.type)) {
        // A scalar field (a date) always holds a value: refuse.
        lines.push(`  call void ${fn}(ptr null, ptr %ctx) ; ${llvmComment(member.name)}`);
        continue;
      }
      lines.push(
        `  %f${n} = getelementptr inbounds %${struct}, ptr %o, i64 0, i32 ${member.index} ; ${llvmComment(member.name)}`,
        `  %v${n} = load ptr, ptr %f${n}`,
        ...this.push(`%v${n}`, fn, `${n}`),
      );
      n++;
    }
    lines.push(`  br label %done`, `done:`, `  ret void`, `}`);
    return lines;
  }
}

/** Unpublishable types stored as scalars (dates are time values, process
 * streams file descriptors): no pointer to push, and always a value. */
function scalarRefusal(t: IrType): boolean {
  return t.kind === "date" || t.kind === "procStream";
}

/** The Node.js implementation's refusal for a value of type `t`. */
function refusalMessage(t: IrType): string {
  switch (t.kind) {
    case "func":
      return "Cannot publish a function";
    case "symbol":
      return "Cannot publish a symbol";
    case "regex":
      return "Cannot publish a RegExp object";
    case "date":
      return "Cannot publish a Date object";
    case "promise":
      return "Cannot publish a Promise object";
    case "bytes":
      return `Cannot publish a ${BYTES_NAMES[t.elem] ?? "Uint8Array"} object`;
    default:
      return "Cannot publish this value";
  }
}

const BYTES_NAMES: Record<string, string> = {
  u8: "Uint8Array",
  u8c: "Uint8ClampedArray",
  i8: "Int8Array",
  u16: "Uint16Array",
  i16: "Int16Array",
  u32: "Uint32Array",
  i32: "Int32Array",
  f32: "Float32Array",
  f64: "Float64Array",
};

function llvmComment(text: string): string {
  return text.replace(/[\r\n]/g, " ");
}

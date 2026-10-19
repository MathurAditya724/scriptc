/* Lowering of a native module (`"use native";`) from the TypeScript source
 * to the native IR (ir.ts). Types come from the annotations, by the
 * provenance of their names in `@scriptc/experimental/native`; expressions
 * are typed by the rules of the native subset (docs: runtime-ts-subset):
 * every integer width is distinct, constants take the type their context
 * needs, and nothing converts implicitly. Interfaces are C struct layouts,
 * and a value of an interface type is a reference to its storage. Anything
 * outside the subset is a diagnostic; there is no fallback to the program
 * lowering. */
import * as ts from "../frontend/ts7/adapter.js";
import { nativeUnitDiag, type ScrDiagnostic } from "../diagnostics/diagnostic.js";
import {
  BOOL,
  RAW_POINTER,
  VOID,
  alignOfType,
  sameType,
  sizeOfType,
  typeName,
  type NativeAttribute,
  type NativeBinaryOp,
  type NativeExpr,
  type NativeExtern,
  type NativeFunction,
  type NativeGlobal,
  type NativeMemType,
  type NativeModule,
  type NativeSlot,
  type NativeStmt,
  type NativeStruct,
  type NativeType,
} from "./ir.js";

export const NATIVE_MODULE = "@scriptc/experimental/native";

const INT_TYPES: Record<string, { bits: 8 | 16 | 32 | 64 | "ptr"; signed: boolean }> = {
  Int8: { bits: 8, signed: true },
  Uint8: { bits: 8, signed: false },
  Int16: { bits: 16, signed: true },
  Uint16: { bits: 16, signed: false },
  Int32: { bits: 32, signed: true },
  Uint32: { bits: 32, signed: false },
  Int64: { bits: 64, signed: true },
  Uint64: { bits: 64, signed: false },
  Size: { bits: "ptr", signed: false },
  Intptr: { bits: "ptr", signed: true },
  Uintptr: { bits: "ptr", signed: false },
  CInt: { bits: 32, signed: true },
};

const ATTRIBUTE_WRAPPERS: Record<string, NativeAttribute> = {
  inline: "inline",
  alwaysInline: "alwaysInline",
  noinline: "noinline",
  cold: "cold",
};

class NativeLoweringError extends Error {
  constructor(readonly diagnostic: ScrDiagnostic) {
    super(diagnostic.message);
  }
}

/** A name a native module can refer to. */
type Binding =
  | { kind: "slot"; slot: number; type: NativeType; mutable: boolean }
  | { kind: "constant"; value: bigint }
  | { kind: "flag"; value: boolean }
  | { kind: "function"; name: string; params: NativeType[]; returnType: NativeType }
  | { kind: "global"; global: NativeGlobal; type: NativeType }
  /** A top-level const naming storage, re-evaluated at each use. */
  | { kind: "alias"; node: ts.Expression }
  | { kind: "struct"; def: NativeStruct }
  | { kind: "native"; member: string };

interface FunctionState {
  fn: NativeFunction;
  loopDepth: number;
}

/** An expression before its type is fixed: an integer constant or `null`
 * takes the type its context asks for. */
type Lowered = { constant: bigint } | { null: true } | { expr: NativeExpr };

/** The build configuration a native module sees as `target`. */
export interface NativeTarget {
  pointerBytes: number;
  os: string;
  arch: string;
  flags: Readonly<Record<string, boolean>>;
}

export function lowerNativeModule(
  program: ts.Program,
  sf: ts.SourceFile,
  target: NativeTarget,
): { module: NativeModule | null; diagnostics: ScrDiagnostic[] } {
  const lowering = new Lowering(program, sf, target);
  try {
    return { module: lowering.run(), diagnostics: lowering.diagnostics };
  } catch (error) {
    if (error instanceof NativeLoweringError)
      return { module: null, diagnostics: [error.diagnostic] };
    throw error;
  }
}

/** Whether a source file opts into the native subset with a leading
 * `"use native";` directive. */
export function isNativeModuleSource(sf: ts.SourceFile): boolean {
  const first = sf.statements[0];
  return (
    first !== undefined &&
    ts.isExpressionStatement(first) &&
    ts.isStringLiteral(first.expression) &&
    first.expression.text === "use native"
  );
}

class Lowering {
  readonly diagnostics: ScrDiagnostic[] = [];
  private readonly checker: ts.TypeChecker;
  private readonly bindings = new Map<ts.Node, Binding>();
  private readonly structs: NativeStruct[] = [];
  private readonly functions: NativeFunction[] = [];
  private readonly externs = new Map<string, NativeExtern>();
  /** Globals the module refers to, in order of first use. */
  private readonly usedGlobals = new Map<string, NativeGlobal>();
  private readonly size: NativeType;
  private readonly intptr: NativeType;
  private readonly uintptr: NativeType;
  private readonly cint: NativeType;
  private state: FunctionState | null = null;
  /** Aliases being expanded, to refuse an alias that names itself. */
  private readonly expanding = new Set<ts.Node>();

  constructor(
    program: ts.Program,
    private readonly sf: ts.SourceFile,
    private readonly target: NativeTarget,
  ) {
    this.checker = program.getTypeChecker();
    const pointerBits = (target.pointerBytes * 8) as 32 | 64;
    this.size = { kind: "int", bits: pointerBits, signed: false, name: "Size" };
    this.intptr = { kind: "int", bits: pointerBits, signed: true, name: "Intptr" };
    this.uintptr = { kind: "int", bits: pointerBits, signed: false, name: "Uintptr" };
    this.cint = { kind: "int", bits: 32, signed: true, name: "CInt" };
  }

  private loc(node: ts.Node): { file: string; start: number; end: number } {
    return { file: this.sf.fileName, start: node.getStart(this.sf), end: node.getEnd() };
  }

  private fail(node: ts.Node, message: string): never {
    throw new NativeLoweringError(nativeUnitDiag(message, this.loc(node)));
  }

  private get pointerBytes(): number {
    return this.target.pointerBytes;
  }

  run(): NativeModule {
    if (!isNativeModuleSource(this.sf))
      this.fail(this.sf, `a native module must start with the directive "use native";`);
    const statements = this.sf.statements.slice(1);
    // Imports and struct names first: declarations and layouts refer to them.
    const interfaces: ts.InterfaceDeclaration[] = [];
    for (const stmt of statements) {
      if (ts.isImportDeclaration(stmt)) this.importDeclaration(stmt);
      else if (ts.isInterfaceDeclaration(stmt)) {
        const def: NativeStruct = {
          name: stmt.name.text,
          cName: null,
          fields: [],
          size: -1,
          align: 1,
        };
        this.bindings.set(stmt, { kind: "struct", def });
        interfaces.push(stmt);
      }
    }
    for (const decl of interfaces) this.layout(decl, []);
    // Then every function, constant and global, so bodies can refer to
    // declarations that come after them.
    const bodies: { decl: ts.FunctionDeclaration | ts.FunctionExpression; fn: NativeFunction }[] =
      [];
    for (const stmt of statements) {
      if (ts.isImportDeclaration(stmt) || ts.isInterfaceDeclaration(stmt)) continue;
      if (ts.isFunctionDeclaration(stmt)) {
        const exported = hasModifier(stmt, ts.SyntaxKind.ExportKeyword);
        const ambient = hasModifier(stmt, ts.SyntaxKind.DeclareKeyword);
        if (stmt.name === undefined) this.fail(stmt, "a native function needs a name");
        if (ambient || stmt.body === undefined) {
          this.externDeclaration(stmt);
          continue;
        }
        const fn = this.declareFunction(stmt, stmt.name.text, exported, []);
        bodies.push({ decl: stmt, fn });
      } else if (ts.isVariableStatement(stmt)) {
        const exported = hasModifier(stmt, ts.SyntaxKind.ExportKeyword);
        if ((stmt.declarationList.flags & ts.NodeFlags.Const) === 0)
          this.fail(stmt, "top-level bindings of a native module must be const");
        if (hasModifier(stmt, ts.SyntaxKind.DeclareKeyword)) {
          for (const decl of stmt.declarationList.declarations) this.globalDeclaration(decl);
          continue;
        }
        for (const decl of stmt.declarationList.declarations) {
          const defined = this.topLevelConst(decl, exported);
          if (defined !== null) bodies.push(defined);
        }
      } else if (ts.isTypeAliasDeclaration(stmt)) {
        this.fail(stmt, "type aliases are not supported in native modules yet");
      } else {
        this.fail(
          stmt,
          `${ts.SyntaxKind[stmt.kind]} is not allowed at the top level of a native module`,
        );
      }
    }
    for (const { decl, fn } of bodies) this.functionBody(decl, fn);
    return {
      file: this.sf.fileName,
      structs: this.structs,
      functions: this.functions,
      externs: [...this.externs.values()],
      globals: [...this.usedGlobals.values()],
    };
  }

  private importDeclaration(stmt: ts.ImportDeclaration): void {
    if (!ts.isStringLiteral(stmt.moduleSpecifier) || stmt.moduleSpecifier.text !== NATIVE_MODULE)
      this.fail(stmt, `native modules can import only from "${NATIVE_MODULE}"`);
    const clause = stmt.importClause;
    if (clause === undefined) return;
    if (clause.name !== undefined) this.fail(clause, `"${NATIVE_MODULE}" has no default export`);
    const named = clause.namedBindings;
    if (named === undefined) return;
    if (!ts.isNamedImports(named))
      this.fail(named, `import the members of "${NATIVE_MODULE}" by name`);
    for (const spec of named.elements) {
      const member = spec.propertyName?.text ?? spec.name.text;
      this.bindings.set(spec, { kind: "native", member });
    }
  }

  /** The declaration a name refers to, through the checker. */
  private declarationOf(ident: ts.Node): ts.Node | undefined {
    const symbol = this.checker.getSymbolAtLocation(ident);
    return symbol === undefined ? undefined : this.checker.declarationsOf(symbol)[0];
  }

  private lookup(ident: ts.Node): Binding | undefined {
    const decl = this.declarationOf(ident);
    return decl === undefined ? undefined : this.bindings.get(decl);
  }

  private bindingOf(ident: ts.Identifier): Binding {
    const binding = this.lookup(ident);
    if (binding === undefined) this.fail(ident, `'${ident.text}' is not a native value`);
    return binding;
  }

  /** The `@scriptc/experimental/native` member a name refers to, if any. */
  private nativeMember(node: ts.Node): string | null {
    if (!ts.isIdentifier(node)) return null;
    const binding = this.lookup(node);
    return binding?.kind === "native" ? binding.member : null;
  }

  // ── types ────────────────────────────────────────────────────────────

  private intType(name: string): NativeType {
    if (name === "Size") return this.size;
    if (name === "Intptr") return this.intptr;
    if (name === "Uintptr") return this.uintptr;
    const spec = INT_TYPES[name]!;
    return { kind: "int", bits: spec.bits as 8 | 16 | 32 | 64, signed: spec.signed, name };
  }

  private typeArgs(node: ts.TypeReferenceNode, count: number, name: string): ts.TypeNode[] {
    const args = node.typeArguments ?? [];
    if (args.length !== count)
      this.fail(node, `${name} takes ${count} type argument${count === 1 ? "" : "s"}`);
    return [...args];
  }

  /** The struct an interface type reference names, if it does. */
  private structOf(node: ts.TypeNode): NativeStruct | null {
    if (!ts.isTypeReferenceNode(node) || !ts.isIdentifier(node.typeName)) return null;
    const binding = this.lookup(node.typeName);
    return binding?.kind === "struct" ? binding.def : null;
  }

  private typeOf(node: ts.TypeNode | undefined, what: string, at: ts.Node): NativeType {
    if (node === undefined) this.fail(at, `${what} needs a native type annotation`);
    if (node.kind === ts.SyntaxKind.BooleanKeyword) return BOOL;
    if (node.kind === ts.SyntaxKind.VoidKeyword) return VOID;
    if (node.kind === ts.SyntaxKind.NeverKeyword) return VOID;
    if (ts.isParenthesizedTypeNode(node)) return this.typeOf(node.type, what, at);
    if (ts.isFunctionTypeNode(node)) return RAW_POINTER; // a function pointer, stored only
    if (ts.isUnionTypeNode(node)) {
      const rest = node.types.filter(
        (t) => !(ts.isLiteralTypeNode(t) && t.literal.kind === ts.SyntaxKind.NullKeyword),
      );
      if (rest.length === 1 && rest.length < node.types.length) {
        const type = this.typeOf(rest[0], what, at);
        if (type.kind === "ptr" || type.kind === "ref") return type;
      }
      this.fail(node, "the only native union is a pointer or struct reference with null");
    }
    const def = this.structOf(node);
    if (def !== null) return { kind: "ref", def };
    if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
      const member = this.nativeMember(node.typeName);
      if (member !== null && member in INT_TYPES) {
        this.typeArgs(node, 0, member);
        return this.intType(member);
      }
      if (member === "RawPointer") return RAW_POINTER;
      if (member === "Pointer") {
        const [arg] = this.typeArgs(node, 1, "Pointer");
        return { kind: "ptr", to: this.typeOf(arg, "a pointee", arg!) };
      }
      if (member !== null) this.fail(node, `${member} is not a value type`);
    }
    this.fail(node, `'${node.getText(this.sf)}' is not a native type`);
  }

  /** The type of a struct field: a value type, `Inline<S>` or `FixedArray<T, N>`. */
  private memTypeOf(node: ts.TypeNode, chain: NativeStruct[]): NativeMemType {
    if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
      const member = this.nativeMember(node.typeName);
      if (member === "Inline") {
        const [arg] = this.typeArgs(node, 1, "Inline");
        const def = this.structOf(arg!);
        if (def === null) this.fail(arg!, "Inline takes a struct interface");
        this.complete(def, chain, arg!);
        return { kind: "inline", def };
      }
      if (member === "FixedArray") {
        const [element, length] = this.typeArgs(node, 2, "FixedArray");
        if (
          !ts.isLiteralTypeNode(length!) ||
          !ts.isNumericLiteral(length.literal) ||
          !/^\d+$/.test(length.literal.text)
        )
          this.fail(length!, "a FixedArray length is a number literal");
        return {
          kind: "array",
          element: this.memTypeOf(element!, chain),
          length: Number(length.literal.text),
        };
      }
    }
    return this.typeOf(node, "a field", node);
  }

  private complete(def: NativeStruct, chain: NativeStruct[], at: ts.Node): void {
    if (def.size >= 0) return;
    const decl = [...this.bindings].find(([, b]) => b.kind === "struct" && b.def === def)![0];
    if (chain.includes(def)) this.fail(at, `'${def.name}' contains itself`);
    this.layout(decl as ts.InterfaceDeclaration, chain);
  }

  /** C's layout of an interface: fields in order at their natural alignment,
   * the size rounded up to the struct's alignment. */
  private layout(decl: ts.InterfaceDeclaration, chain: NativeStruct[]): void {
    const def = (this.bindings.get(decl) as { kind: "struct"; def: NativeStruct }).def;
    if (def.size >= 0) return;
    if (decl.typeParameters !== undefined) this.fail(decl, "struct interfaces cannot be generic");
    for (const clause of decl.heritageClauses ?? []) {
      for (const base of clause.types) {
        if (this.nativeMember(base.expression) !== "CStruct")
          this.fail(base, 'a struct interface can extend only CStruct<"Name">');
        const arg = base.typeArguments?.[0];
        if (
          arg === undefined ||
          !ts.isLiteralTypeNode(arg) ||
          !ts.isStringLiteral(arg.literal) ||
          base.typeArguments!.length !== 1
        )
          this.fail(base, "CStruct takes the C struct's name as a string literal");
        def.cName = arg.literal.text;
      }
    }
    let offset = 0;
    let align = 1;
    for (const member of decl.members) {
      if (
        !ts.isPropertySignature(member) ||
        !ts.isIdentifier(member.name) ||
        member.type === undefined
      )
        this.fail(member, "a struct interface has only named fields with types");
      if (member.questionToken !== undefined) this.fail(member, "struct fields cannot be optional");
      const type = this.memTypeOf(member.type, [...chain, def]);
      const fieldAlign = alignOfType(type, this.pointerBytes);
      offset = Math.ceil(offset / fieldAlign) * fieldAlign;
      def.fields.push({ name: member.name.text, type, offset });
      offset += sizeOfType(type, this.pointerBytes);
      align = Math.max(align, fieldAlign);
    }
    def.align = align;
    def.size = Math.ceil(offset / align) * align;
    this.structs.push(def);
  }

  // ── declarations ─────────────────────────────────────────────────────

  private signature(decl: ts.SignatureDeclaration): {
    params: NativeSlot[];
    returnType: NativeType;
  } {
    const params: NativeSlot[] = [];
    for (const p of decl.parameters) {
      if (!ts.isIdentifier(p.name)) this.fail(p, "native parameters cannot be destructured");
      if (
        p.initializer !== undefined ||
        p.questionToken !== undefined ||
        p.dotDotDotToken !== undefined
      )
        this.fail(p, "native parameters cannot be optional, defaulted or rest parameters");
      params.push({
        name: p.name.text,
        type: this.typeOf(p.type, `parameter '${p.name.text}'`, p),
      });
    }
    return { params, returnType: this.typeOf(decl.type, "the return", decl) };
  }

  private declareFunction(
    decl: ts.FunctionDeclaration | ts.FunctionExpression,
    name: string,
    exported: boolean,
    attributes: NativeAttribute[],
  ): NativeFunction {
    if (hasModifier(decl, ts.SyntaxKind.AsyncKeyword) || decl.asteriskToken !== undefined)
      this.fail(decl, "native functions cannot be async or generators");
    if (decl.typeParameters !== undefined)
      this.fail(decl, "native functions cannot be generic yet");
    if (this.functions.some((f) => f.name === name) || this.externs.has(name))
      this.fail(decl, `'${name}' is defined twice`);
    const { params, returnType } = this.signature(decl);
    const fn: NativeFunction = {
      name,
      exported,
      attributes,
      params,
      returnType,
      slots: params.map((p) => ({ ...p })),
      body: [],
    };
    this.functions.push(fn);
    this.bindings.set(decl, {
      kind: "function",
      name,
      params: params.map((p) => p.type),
      returnType,
    });
    return fn;
  }

  private externDeclaration(stmt: ts.FunctionDeclaration): void {
    const name = stmt.name!.text;
    const { params, returnType } = this.signature(stmt);
    if (this.functions.some((f) => f.name === name)) this.fail(stmt, `'${name}' is defined twice`);
    this.externs.set(name, { name, params: params.map((p) => p.type), returnType, builtin: false });
    this.bindings.set(stmt, {
      kind: "function",
      name,
      params: params.map((p) => p.type),
      returnType,
    });
  }

  /** `declare const name: S`, with `ThreadLocal<…>` and `Extern<…, "symbol">`. */
  private globalDeclaration(decl: ts.VariableDeclaration): void {
    if (!ts.isIdentifier(decl.name)) this.fail(decl, "declarations cannot be destructured");
    let node = decl.type;
    if (node === undefined) this.fail(decl, `'${decl.name.text}' needs a type`);
    let symbol = decl.name.text;
    let threadLocal = false;
    for (;;) {
      const member =
        ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)
          ? this.nativeMember(node.typeName)
          : null;
      if (member === "Extern") {
        const [inner, name] = this.typeArgs(node as ts.TypeReferenceNode, 2, "Extern");
        if (!ts.isLiteralTypeNode(name!) || !ts.isStringLiteral(name.literal))
          this.fail(name!, "Extern takes the symbol as a string literal");
        symbol = name.literal.text;
        node = inner!;
      } else if (member === "ThreadLocal") {
        const [inner] = this.typeArgs(node as ts.TypeReferenceNode, 1, "ThreadLocal");
        threadLocal = true;
        node = inner!;
      } else break;
    }
    const def = this.structOf(node);
    if (def === null) this.fail(node, "a declared global is a struct interface");
    const global: NativeGlobal = {
      symbol,
      type: { kind: "inline", def },
      threadLocal,
      align: def.align,
    };
    this.bindings.set(decl, { kind: "global", global, type: { kind: "ref", def } });
  }

  /** `const NAME = <constant>`, `const NAME = wrapper(function NAME(...) {...})`,
   * or `const NAME = <storage>`, an alias. */
  private topLevelConst(
    decl: ts.VariableDeclaration,
    exported: boolean,
  ): { decl: ts.FunctionExpression; fn: NativeFunction } | null {
    if (!ts.isIdentifier(decl.name)) this.fail(decl, "top-level bindings cannot be destructured");
    const name = decl.name.text;
    const init = decl.initializer;
    if (init === undefined) this.fail(decl, `'${name}' needs an initializer`);
    const attributes: NativeAttribute[] = [];
    let inner: ts.Expression = init;
    while (ts.isCallExpression(inner)) {
      const member = this.nativeMember(inner.expression);
      const attribute = member === null ? undefined : ATTRIBUTE_WRAPPERS[member];
      if (attribute === undefined) break;
      if (inner.arguments.length !== 1) this.fail(inner, `${member} takes one function`);
      if (attributes.includes(attribute)) this.fail(inner, `${member} is applied twice`);
      attributes.push(attribute);
      inner = inner.arguments[0]!;
    }
    if (attributes.length > 0) {
      if (!ts.isFunctionExpression(inner))
        this.fail(inner, "an attribute wrapper takes a function expression");
      if (inner.name !== undefined && inner.name.text !== name)
        this.fail(inner.name, `the function's name must be '${name}', the name of its const`);
      if (decl.type !== undefined)
        this.fail(decl.type, "a wrapped function takes its type from its signature");
      const fn = this.declareFunction(inner, name, exported, attributes);
      this.bindings.set(decl, this.bindings.get(inner)!);
      return { decl: inner, fn };
    }
    if (exported) this.fail(decl, "native modules cannot export constants yet");
    if (decl.type !== undefined)
      this.fail(decl.type, "a top-level const takes its type from its initializer");
    const value = this.constantValue(init);
    if (value !== null) {
      this.bindings.set(decl, { kind: "constant", value });
      return null;
    }
    const flag = this.foldCondition(init);
    if (flag !== null) {
      this.bindings.set(decl, { kind: "flag", value: flag });
      return null;
    }
    if (!this.isStorage(init))
      this.fail(
        init,
        "a top-level const is a constant, a target condition, or an alias of a declared global, a thread-local or a field of one",
      );
    this.bindings.set(decl, { kind: "alias", node: init });
    return null;
  }

  /** Whether `expr` names storage: a declared global or thread-local, an
   * alias of one, a field of storage, or a conditional between storage. */
  private isStorage(expr: ts.Expression): boolean {
    if (ts.isParenthesizedExpression(expr)) return this.isStorage(expr.expression);
    if (ts.isIdentifier(expr)) {
      const binding = this.lookup(expr);
      return binding?.kind === "global" || binding?.kind === "alias";
    }
    if (ts.isPropertyAccessExpression(expr))
      return this.nativeMember(expr.expression) !== "target" && this.isStorage(expr.expression);
    if (ts.isConditionalExpression(expr))
      return this.isStorage(expr.whenTrue) && this.isStorage(expr.whenFalse);
    return false;
  }

  /** The value of a constant expression: literals, constants and operators over them. */
  private constantValue(expr: ts.Expression): bigint | null {
    if (ts.isParenthesizedExpression(expr)) return this.constantValue(expr.expression);
    if (ts.isBigIntLiteral(expr)) return BigInt(expr.text.slice(0, -1));
    if (ts.isIdentifier(expr)) {
      const binding = this.lookup(expr);
      return binding?.kind === "constant" ? binding.value : null;
    }
    if (ts.isPrefixUnaryExpression(expr)) {
      const v = this.constantValue(expr.operand);
      if (v === null) return null;
      if (expr.operator === ts.SyntaxKind.MinusToken) return -v;
      if (expr.operator === ts.SyntaxKind.TildeToken) return ~v;
      return null;
    }
    if (ts.isBinaryExpression(expr)) {
      const a = this.constantValue(expr.left);
      const b = this.constantValue(expr.right);
      if (a === null || b === null) return null;
      switch (expr.operatorToken.kind) {
        case ts.SyntaxKind.PlusToken:
          return a + b;
        case ts.SyntaxKind.MinusToken:
          return a - b;
        case ts.SyntaxKind.AsteriskToken:
          return a * b;
        case ts.SyntaxKind.SlashToken:
          if (b === 0n) this.fail(expr, "division by zero in a constant");
          return a / b;
        case ts.SyntaxKind.PercentToken:
          if (b === 0n) this.fail(expr, "division by zero in a constant");
          return a % b;
        case ts.SyntaxKind.AmpersandToken:
          return a & b;
        case ts.SyntaxKind.BarToken:
          return a | b;
        case ts.SyntaxKind.CaretToken:
          return a ^ b;
        case ts.SyntaxKind.LessThanLessThanToken:
          return a << b;
        case ts.SyntaxKind.GreaterThanGreaterThanToken:
          return a >> b;
      }
    }
    return null;
  }

  /** A `target` field, as a boolean, string or integer constant. */
  private targetField(expr: ts.Expression): boolean | string | bigint | null {
    if (!ts.isPropertyAccessExpression(expr) || this.nativeMember(expr.expression) !== "target")
      return null;
    const name = expr.name.text;
    if (name === "os") return this.target.os;
    if (name === "arch") return this.target.arch;
    if (name === "pointerBytes") return BigInt(this.target.pointerBytes);
    const flag = this.target.flags[name];
    if (flag === undefined) this.fail(expr.name, `target has no field '${name}'`);
    return flag;
  }

  /** The value of a condition known at compile time: `true`, `false`, flags,
   * `target` fields and the logical operators over them, and comparisons of
   * `target.os`, `target.arch` and `target.pointerBytes` with literals. */
  private foldCondition(expr: ts.Expression): boolean | null {
    if (ts.isParenthesizedExpression(expr)) return this.foldCondition(expr.expression);
    if (expr.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (expr.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (ts.isIdentifier(expr)) {
      const binding = this.lookup(expr);
      return binding?.kind === "flag" ? binding.value : null;
    }
    const field = this.targetField(expr);
    if (typeof field === "boolean") return field;
    if (field !== null) this.fail(expr, "compare this target field with a literal");
    if (ts.isPrefixUnaryExpression(expr) && expr.operator === ts.SyntaxKind.ExclamationToken) {
      const v = this.foldCondition(expr.operand);
      return v === null ? null : !v;
    }
    if (!ts.isBinaryExpression(expr)) return null;
    const k = expr.operatorToken.kind;
    if (k === ts.SyntaxKind.AmpersandAmpersandToken || k === ts.SyntaxKind.BarBarToken) {
      const a = this.foldCondition(expr.left);
      const b = this.foldCondition(expr.right);
      if (a === null || b === null) return null;
      return k === ts.SyntaxKind.AmpersandAmpersandToken ? a && b : a || b;
    }
    if (
      k === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      k === ts.SyntaxKind.ExclamationEqualsEqualsToken
    ) {
      const side = (e: ts.Expression): boolean | string | bigint | null =>
        ts.isStringLiteral(e) ? e.text : (this.targetField(e) ?? this.constantValue(e));
      const a = side(expr.left);
      const b = side(expr.right);
      if (a === null || b === null) return null;
      return (a === b) === (k === ts.SyntaxKind.EqualsEqualsEqualsToken);
    }
    return null;
  }

  // ── function bodies ──────────────────────────────────────────────────

  private functionBody(
    decl: ts.FunctionDeclaration | ts.FunctionExpression,
    fn: NativeFunction,
  ): void {
    this.state = { fn, loopDepth: 0 };
    decl.parameters.forEach((p, i) =>
      this.bindings.set(p, { kind: "slot", slot: i, type: fn.params[i]!.type, mutable: true }),
    );
    fn.body = this.block(decl.body!.statements);
    const last = fn.body.at(-1);
    if (fn.returnType.kind !== "void" && !endsInReturn(fn.body) && last?.kind !== "loop")
      this.fail(decl, `'${fn.name}' can reach its end without returning a value`);
    this.state = null;
  }

  private block(statements: readonly ts.Statement[]): NativeStmt[] {
    const out: NativeStmt[] = [];
    for (const stmt of statements) this.statement(stmt, out);
    return out;
  }

  private newSlot(name: string, type: NativeType): number {
    const fn = this.state!.fn;
    fn.slots.push({ name, type });
    return fn.slots.length - 1;
  }

  private statement(stmt: ts.Statement, out: NativeStmt[]): void {
    const fn = this.state!.fn;
    if (ts.isBlock(stmt)) {
      out.push({ kind: "scope", body: this.block(stmt.statements) });
    } else if (ts.isVariableStatement(stmt)) {
      this.variableDeclarations(stmt.declarationList, out);
    } else if (ts.isExpressionStatement(stmt)) {
      out.push(this.expressionStatement(stmt.expression));
    } else if (ts.isIfStatement(stmt)) {
      // A condition known at compile time keeps only its branch, as `#if`
      // does: a block's statements join the enclosing block.
      const folded = this.foldCondition(stmt.expression);
      const kept =
        folded === true ? stmt.thenStatement : folded === false ? stmt.elseStatement : null;
      if (kept !== null) {
        if (kept !== undefined)
          out.push(...this.block(ts.isBlock(kept) ? kept.statements : [kept]));
      } else
        out.push({
          kind: "if",
          condition: this.condition(stmt.expression),
          consequent: this.block([stmt.thenStatement]),
          alternative: stmt.elseStatement === undefined ? [] : this.block([stmt.elseStatement]),
        });
    } else if (ts.isWhileStatement(stmt) || ts.isDoStatement(stmt)) {
      const constant = this.constantCondition(stmt.expression);
      const condition = constant === true ? null : this.condition(stmt.expression);
      this.state!.loopDepth++;
      const body = this.block([stmt.statement]);
      this.state!.loopDepth--;
      out.push({
        kind: "loop",
        form: ts.isWhileStatement(stmt) ? "while" : "do",
        init: [],
        condition,
        body,
        update: [],
        mustProgress: constant === null,
      });
    } else if (ts.isForStatement(stmt)) {
      const init: NativeStmt[] = [];
      if (stmt.initializer !== undefined) {
        if (ts.isVariableDeclarationList(stmt.initializer))
          this.variableDeclarations(stmt.initializer, init);
        else init.push(this.expressionStatement(stmt.initializer as ts.Expression));
      }
      // clang branches on a `for` condition even when it is constant.
      const constant = stmt.condition === undefined ? true : this.constantCondition(stmt.condition);
      const condition = stmt.condition === undefined ? null : this.condition(stmt.condition);
      this.state!.loopDepth++;
      const body = this.block([stmt.statement]);
      this.state!.loopDepth--;
      const update =
        stmt.incrementor === undefined ? [] : [this.expressionStatement(stmt.incrementor)];
      out.push({
        kind: "loop",
        form: "for",
        init,
        condition,
        body,
        update,
        mustProgress: constant === null,
      });
    } else if (ts.isReturnStatement(stmt)) {
      if (stmt.expression === undefined) {
        if (fn.returnType.kind !== "void")
          this.fail(stmt, `'${fn.name}' must return a ${typeName(fn.returnType)}`);
        out.push({ kind: "return", value: null });
      } else if (fn.returnType.kind === "void") {
        // `return f();` in a void function, as C allows for a void call.
        const lowered = this.expression(stmt.expression);
        if (!("expr" in lowered) || lowered.expr.type.kind !== "void")
          this.fail(stmt, `'${fn.name}' returns void`);
        out.push({ kind: "expr", expr: lowered.expr }, { kind: "return", value: null });
      } else {
        out.push({ kind: "return", value: this.valueAs(stmt.expression, fn.returnType) });
      }
    } else if (
      stmt.kind === ts.SyntaxKind.BreakStatement ||
      stmt.kind === ts.SyntaxKind.ContinueStatement
    ) {
      const jump = stmt as ts.BreakStatement | ts.ContinueStatement;
      if (jump.label !== undefined)
        this.fail(stmt, "labeled jumps are not supported in native modules yet");
      if (this.state!.loopDepth === 0) this.fail(stmt, "break and continue must be inside a loop");
      out.push({ kind: stmt.kind === ts.SyntaxKind.BreakStatement ? "break" : "continue" });
    } else {
      this.fail(stmt, `${ts.SyntaxKind[stmt.kind]} is not allowed in a native module`);
    }
  }

  private variableDeclarations(list: ts.VariableDeclarationList, out: NativeStmt[]): void {
    if ((list.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) === 0)
      this.fail(list, "use let or const, not var");
    const mutable = (list.flags & ts.NodeFlags.Const) === 0;
    for (const decl of list.declarations) {
      if (!ts.isIdentifier(decl.name)) this.fail(decl, "native bindings cannot be destructured");
      if (decl.initializer === undefined)
        this.fail(decl, `'${decl.name.text}' needs an initializer`);
      let type: NativeType;
      let value: NativeExpr;
      if (decl.type !== undefined) {
        type = this.typeOf(decl.type, `'${decl.name.text}'`, decl);
        value = this.valueAs(decl.initializer, type);
      } else {
        const lowered = this.expression(decl.initializer);
        if (!("expr" in lowered))
          this.fail(
            decl,
            `'${decl.name.text}' needs a type annotation: its initializer has no type of its own`,
          );
        value = lowered.expr;
        type = value.type;
      }
      if (type.kind === "void" || type.kind === "arrayref")
        this.fail(decl, `a binding cannot hold ${typeName(type)}`);
      const slot = this.newSlot(decl.name.text, type);
      this.bindings.set(decl, { kind: "slot", slot, type, mutable });
      out.push({ kind: "declare", slot });
      if (value.kind === "load" && value.unaligned === true && type.kind === "int")
        out.push({ kind: "copyToLocal", slot, source: value.pointer, size: type.bits / 8 });
      else out.push({ kind: "expr", expr: { kind: "assign", type, slot, value } });
    }
  }

  /** true or false when a loop condition is a constant expression. */
  private constantCondition(expr: ts.Expression): boolean | null {
    if (expr.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (expr.kind === ts.SyntaxKind.FalseKeyword) return false;
    return null;
  }

  /** The address a store writes and the type stored there, for a field,
   * an embedded array element or a pointer's pointee. */
  private store(pointer: NativeExpr, type: NativeType, value: ts.Expression): NativeStmt {
    return {
      kind: "store",
      pointer,
      value: this.valueAs(value, type),
      align: this.addressAlign(pointer),
    };
  }

  private expressionStatement(expr: ts.Expression): NativeStmt {
    if (ts.isCallExpression(expr) && ts.isPropertyAccessExpression(expr.expression)) {
      const name = expr.expression.name.text;
      if (name === "set") {
        const receiver = this.typed(
          this.expression(expr.expression.expression),
          expr.expression.expression,
        );
        if (receiver.type.kind === "arrayref") {
          if (expr.arguments.length !== 2) this.fail(expr, "set takes an index and a value");
          const element = this.element(receiver, expr.arguments[0]!);
          return this.store(element, (element.type as { to: NativeType }).to, expr.arguments[1]!);
        }
        if (receiver.type.kind !== "ptr")
          this.fail(expr.expression, `${typeName(receiver.type)} has no set`);
        const pointee = receiver.type.to;
        if (pointee === null)
          this.fail(expr.expression, "a RawPointer has no pointee; cast it first");
        if (expr.arguments.length !== 1) this.fail(expr, "set takes one value");
        return {
          kind: "store",
          pointer: receiver,
          value: this.valueAs(expr.arguments[0]!, pointee),
          align: alignOfType(pointee, this.pointerBytes),
        };
      }
    }
    if (ts.isCallExpression(expr) && this.nativeMember(expr.expression) === "memset") {
      if (expr.arguments.length !== 3) this.fail(expr, "memset takes three arguments");
      const pointer = this.pointer(expr.arguments[0]!);
      return {
        kind: "memset",
        pointer,
        byte: this.valueAs(expr.arguments[1]!, this.cint),
        size: this.valueAs(expr.arguments[2]!, this.size),
        align: this.addressAlign(pointer),
      };
    }
    if (ts.isBinaryExpression(expr) && ts.isPropertyAccessExpression(expr.left)) {
      const k = expr.operatorToken.kind;
      if (k === ts.SyntaxKind.EqualsToken || isCompoundAssignment(k)) {
        const field = this.fieldOf(expr.left);
        if (field.memType.kind === "inline" || field.memType.kind === "array")
          this.fail(expr.left, `'${expr.left.name.text}' is embedded storage; assign its fields`);
        const type = field.memType;
        if (k === ts.SyntaxKind.EqualsToken) return this.store(field.address, type, expr.right);
        if (type.kind !== "int") this.fail(expr, "compound assignment needs an integer");
        const op = BINARY_OPS.get(COMPOUND_TO_BINARY.get(k)!)!;
        const rhs =
          op === "shl" || op === "shr"
            ? this.shiftCount(expr.right, type)
            : this.valueAs(expr.right, type);
        return {
          kind: "store",
          pointer: field.address,
          value: rhs,
          align: this.addressAlign(field.address),
          op,
        };
      }
    }
    const lowered = this.expression(expr);
    if (!("expr" in lowered)) this.fail(expr, "a constant on its own does nothing");
    return { kind: "expr", expr: lowered.expr };
  }

  private condition(expr: ts.Expression): NativeExpr {
    return this.valueAs(expr, BOOL);
  }

  /** Lowers `expr` to a value of type `type`, adapting constants and null. */
  private valueAs(expr: ts.Expression, type: NativeType): NativeExpr {
    return this.coerce(this.expression(expr), type, expr);
  }

  private coerce(lowered: Lowered, type: NativeType, at: ts.Node): NativeExpr {
    if ("constant" in lowered) return this.constantAs(lowered.constant, type, at);
    if ("null" in lowered) {
      if (type.kind !== "ptr" && type.kind !== "ref")
        this.fail(at, `null cannot be a ${typeName(type)}`);
      return { kind: "null", type };
    }
    const from = lowered.expr.type;
    // Every pointer and struct reference converts to RawPointer, as to void *.
    const toRaw =
      type.kind === "ptr" && type.to === null && (from.kind === "ptr" || from.kind === "ref");
    if (!sameType(from, type) && !toRaw)
      this.fail(at, `expected ${typeName(type)}, found ${typeName(from)}; convert explicitly`);
    return lowered.expr;
  }

  private constantAs(value: bigint, type: NativeType, at: ts.Node): NativeExpr {
    if (type.kind !== "int") this.fail(at, `an integer constant cannot be a ${typeName(type)}`);
    const min = type.signed ? -(1n << BigInt(type.bits - 1)) : 0n;
    const max = type.signed ? (1n << BigInt(type.bits - 1)) - 1n : (1n << BigInt(type.bits)) - 1n;
    if (value < min || value > max) this.fail(at, `${value} does not fit in ${typeName(type)}`);
    return { kind: "const", type, value };
  }

  private typed(lowered: Lowered, at: ts.Node): NativeExpr {
    if ("constant" in lowered)
      this.fail(at, "this constant needs a type from its context; convert it explicitly");
    if ("null" in lowered) this.fail(at, "this null needs a type from its context");
    return lowered.expr;
  }

  /** The alignment C knows for an address, as the alignment of loads and
   * stores through it: a struct's for a reference to it, the gcd of the
   * base's and the offset's for a field, the element type's for an element
   * or a pointer's pointee. */
  private addressAlign(e: NativeExpr): number {
    switch (e.kind) {
      case "global":
        return e.align;
      case "fieldAddress": {
        const base = this.addressAlign(e.base);
        const offset = e.def.fields[e.index]!.offset;
        return offset === 0 ? base : Math.min(base, offset & -offset);
      }
      case "elementAddress":
        return Math.min(this.addressAlign(e.base), alignOfType(e.element, this.pointerBytes));
      default:
        if (e.type.kind === "ref") return e.type.def.align;
        if (e.type.kind === "ptr" && e.type.to !== null)
          return alignOfType(e.type.to, this.pointerBytes);
        return 1;
    }
  }

  /** A field of a struct reference: its address and its type in memory. */
  private fieldOf(access: ts.PropertyAccessExpression): {
    address: NativeExpr;
    memType: NativeMemType;
  } {
    const base = this.typed(this.expression(access.expression), access.expression);
    if (base.type.kind !== "ref")
      this.fail(access.expression, `${typeName(base.type)} has no fields`);
    const def = base.type.def;
    const index = def.fields.findIndex((f) => f.name === access.name.text);
    if (index < 0) this.fail(access.name, `'${def.name}' has no field '${access.name.text}'`);
    const memType = def.fields[index]!.type;
    const type: NativeType =
      memType.kind === "inline"
        ? { kind: "ref", def: memType.def }
        : memType.kind === "array"
          ? { kind: "arrayref", element: memType.element, length: memType.length }
          : { kind: "ptr", to: memType };
    return { address: { kind: "fieldAddress", type, base, def, index }, memType };
  }

  /** The address of an element of an embedded array, typed as a pointer to it. */
  private element(array: NativeExpr, index: ts.Expression): NativeExpr {
    const a = array.type as { kind: "arrayref"; element: NativeMemType; length: number };
    const lowered = this.expression(index);
    const i =
      "constant" in lowered
        ? this.constantAs(lowered.constant, this.size, index)
        : this.typed(lowered, index);
    if (i.type.kind !== "int") this.fail(index, "an index is an integer");
    if (a.element.kind === "inline" || a.element.kind === "array")
      this.fail(index, "arrays of embedded structs or arrays are not supported yet");
    return {
      kind: "elementAddress",
      type: { kind: "ptr", to: a.element },
      base: array,
      element: a.element,
      length: a.length,
      index: i,
    };
  }

  private expression(expr: ts.Expression): Lowered {
    const constant = this.constantValue(expr);
    if (constant !== null) return { constant };
    const folded = this.foldCondition(expr);
    if (folded !== null) return { expr: { kind: "const", type: BOOL, value: folded ? 1n : 0n } };
    if (ts.isParenthesizedExpression(expr)) return this.expression(expr.expression);
    if (expr.kind === ts.SyntaxKind.NullKeyword) return { null: true };
    if (ts.isIdentifier(expr)) {
      const binding = this.bindingOf(expr);
      switch (binding.kind) {
        case "slot":
          return { expr: { kind: "local", type: binding.type, slot: binding.slot } };
        case "global": {
          const g = binding.global;
          this.usedGlobals.set(g.symbol, g);
          return {
            expr: {
              kind: "global",
              type: binding.type,
              name: g.symbol,
              threadLocal: g.threadLocal,
              align: g.align,
            },
          };
        }
        case "alias": {
          if (this.expanding.has(binding.node)) this.fail(expr, `'${expr.text}' refers to itself`);
          this.expanding.add(binding.node);
          try {
            return this.expression(binding.node);
          } finally {
            this.expanding.delete(binding.node);
          }
        }
        default:
          this.fail(expr, `'${expr.text}' is not a value; call it`);
      }
    }
    if (ts.isPropertyAccessExpression(expr)) {
      if (this.nativeMember(expr.expression) === "target")
        this.fail(expr, "compare this target field with a literal");
      const field = this.fieldOf(expr);
      const t = field.memType;
      if (t.kind === "inline" || t.kind === "array") return { expr: field.address };
      return {
        expr: {
          kind: "load",
          type: t,
          pointer: field.address,
          align: this.addressAlign(field.address),
        },
      };
    }
    if (ts.isBinaryExpression(expr)) return this.binary(expr);
    if (ts.isPrefixUnaryExpression(expr)) return this.prefixUnary(expr);
    if (ts.isPostfixUnaryExpression(expr))
      return { expr: this.step(expr.operand, expr.operator, true) };
    if (ts.isConditionalExpression(expr)) {
      const pick = this.foldCondition(expr.condition);
      if (pick !== null) return this.expression(pick ? expr.whenTrue : expr.whenFalse);
      const condition = this.condition(expr.condition);
      const a = this.expression(expr.whenTrue);
      const b = this.expression(expr.whenFalse);
      const type = this.unify(a, b, expr);
      return {
        expr: {
          kind: "conditional",
          type,
          condition,
          whenTrue: this.coerce(a, type, expr.whenTrue),
          whenFalse: this.coerce(b, type, expr.whenFalse),
        },
      };
    }
    if (ts.isCallExpression(expr)) return this.call(expr);
    if (ts.isNumericLiteral(expr))
      this.fail(expr, "integer constants in native modules are bigint literals: write 1n");
    this.fail(expr, `${ts.SyntaxKind[expr.kind]} is not allowed in a native module`);
  }

  /** The common type of two operands, either of which may be a constant or null. */
  private unify(a: Lowered, b: Lowered, at: ts.Node): NativeType {
    if ("expr" in a && "expr" in b) {
      if (!sameType(a.expr.type, b.expr.type))
        this.fail(
          at,
          `operands are ${typeName(a.expr.type)} and ${typeName(b.expr.type)}; convert one explicitly`,
        );
      return a.expr.type;
    }
    if ("expr" in a) return a.expr.type;
    if ("expr" in b) return b.expr.type;
    this.fail(at, "this constant expression needs a type from its context");
  }

  private shiftCount(expr: ts.Expression, type: NativeType): NativeExpr {
    // The count converts to the shifted type, as in C after promotion.
    const r = this.expression(expr);
    return "constant" in r
      ? this.constantAs(r.constant, type, expr)
      : this.convertTo(this.typed(r, expr), type);
  }

  private binary(expr: ts.BinaryExpression): Lowered {
    const k = expr.operatorToken.kind;
    if (k === ts.SyntaxKind.EqualsToken || isCompoundAssignment(k))
      return { expr: this.assignment(expr) };
    if (k === ts.SyntaxKind.AmpersandAmpersandToken || k === ts.SyntaxKind.BarBarToken) {
      return {
        expr: {
          kind: "logical",
          type: BOOL,
          op: k === ts.SyntaxKind.AmpersandAmpersandToken ? "and" : "or",
          left: this.condition(expr.left),
          right: this.condition(expr.right),
        },
      };
    }
    if (k === ts.SyntaxKind.EqualsEqualsToken || k === ts.SyntaxKind.ExclamationEqualsToken)
      this.fail(expr.operatorToken, "use === or !== in native modules");
    const op = BINARY_OPS.get(k);
    if (op === undefined)
      this.fail(
        expr.operatorToken,
        `${ts.tokenToString(k) ?? ts.SyntaxKind[k]} is not a native operator`,
      );
    const a = this.expression(expr.left);
    if (op === "shl" || op === "shr") {
      const left = this.typed(a, expr.left);
      if (left.type.kind !== "int") this.fail(expr.left, "shifts need an integer operand");
      return {
        expr: {
          kind: "binary",
          type: left.type,
          op,
          left,
          right: this.shiftCount(expr.right, left.type),
        },
      };
    }
    const b = this.expression(expr.right);
    const type = this.unify(a, b, expr);
    const left = this.coerce(a, type, expr.left);
    const right = this.coerce(b, type, expr.right);
    const comparison =
      op === "eq" || op === "ne" || op === "lt" || op === "le" || op === "gt" || op === "ge";
    const pointerLike = type.kind === "ptr" || type.kind === "ref";
    if (pointerLike && !(op === "eq" || op === "ne"))
      this.fail(expr.operatorToken, "pointers compare only with === and !==");
    if (type.kind === "bool" && !(op === "eq" || op === "ne"))
      this.fail(expr.operatorToken, "booleans compare only with === and !==");
    if (type.kind !== "int" && !comparison)
      this.fail(expr.operatorToken, `${typeName(type)} has no arithmetic`);
    return { expr: { kind: "binary", type: comparison ? BOOL : type, op, left, right } };
  }

  private prefixUnary(expr: ts.PrefixUnaryExpression): Lowered {
    switch (expr.operator) {
      case ts.SyntaxKind.ExclamationToken:
        return { expr: { kind: "not", type: BOOL, operand: this.condition(expr.operand) } };
      case ts.SyntaxKind.TildeToken: {
        const operand = this.typed(this.expression(expr.operand), expr.operand);
        if (operand.type.kind !== "int") this.fail(expr, "~ needs an integer");
        return { expr: { kind: "complement", type: operand.type, operand } };
      }
      case ts.SyntaxKind.MinusToken: {
        const operand = this.typed(this.expression(expr.operand), expr.operand);
        if (operand.type.kind !== "int") this.fail(expr, "- needs an integer");
        return { expr: { kind: "negate", type: operand.type, operand } };
      }
      case ts.SyntaxKind.PlusPlusToken:
      case ts.SyntaxKind.MinusMinusToken:
        return { expr: this.step(expr.operand, expr.operator, false) };
    }
    this.fail(expr, `${ts.tokenToString(expr.operator)} is not a native operator`);
  }

  private mutableSlot(target: ts.Expression): { slot: number; type: NativeType } {
    if (!ts.isIdentifier(target))
      this.fail(target, "only locals, parameters and struct fields can be assigned");
    const binding = this.bindingOf(target);
    if (binding.kind !== "slot") this.fail(target, `'${target.text}' cannot be assigned`);
    if (!binding.mutable) this.fail(target, `'${target.text}' is const`);
    return binding;
  }

  private step(target: ts.Expression, operator: ts.SyntaxKind, postfix: boolean): NativeExpr {
    const { slot, type } = this.mutableSlot(target);
    if (type.kind !== "int") this.fail(target, "++ and -- need an integer");
    return {
      kind: "step",
      type,
      slot,
      delta: operator === ts.SyntaxKind.PlusPlusToken ? 1n : -1n,
      postfix,
    };
  }

  private assignment(expr: ts.BinaryExpression): NativeExpr {
    if (ts.isPropertyAccessExpression(expr.left))
      this.fail(expr, "a field assignment is a statement, not a value");
    const { slot, type } = this.mutableSlot(expr.left);
    const k = expr.operatorToken.kind;
    if (k === ts.SyntaxKind.EqualsToken)
      return { kind: "assign", type, slot, value: this.valueAs(expr.right, type) };
    const op = BINARY_OPS.get(COMPOUND_TO_BINARY.get(k)!)!;
    if (type.kind !== "int") this.fail(expr, "compound assignment needs an integer");
    const value =
      op === "shl" || op === "shr"
        ? this.shiftCount(expr.right, type)
        : this.valueAs(expr.right, type);
    return { kind: "assign", type, slot, value, op };
  }

  /** An integer or boolean converted to an integer type, as a C cast does. */
  private convertTo(value: NativeExpr, type: NativeType): NativeExpr {
    if (sameType(value.type, type)) return value;
    return { kind: "convert", type, operand: value };
  }

  // ── calls ─────────────────────────────────────────────────────────────

  private call(expr: ts.CallExpression): Lowered {
    if (expr.questionDotToken !== undefined) this.fail(expr, "optional calls are not native");
    const callee = expr.expression;
    if (ts.isPropertyAccessExpression(callee)) return this.methodCall(expr, callee);
    if (!ts.isIdentifier(callee)) this.fail(callee, "native calls name a function directly");
    const member = this.nativeMember(callee);
    if (member !== null) return this.builtinCall(expr, member);
    const binding = this.bindingOf(callee);
    if (binding.kind !== "function") this.fail(callee, `'${callee.text}' is not a function`);
    if (expr.typeArguments !== undefined)
      this.fail(expr, "native functions take no type arguments");
    if (expr.arguments.length !== binding.params.length)
      this.fail(expr, `'${binding.name}' takes ${binding.params.length} arguments`);
    const args = expr.arguments.map((arg, i) => this.valueAs(arg, binding.params[i]!));
    return { expr: { kind: "call", type: binding.returnType, callee: binding.name, args } };
  }

  /** A libc function the probe declares (probe.ts). */
  private libcCall(
    name: string,
    params: NativeType[],
    returnType: NativeType,
    args: readonly ts.Expression[],
    at: ts.Node,
  ): Lowered {
    if (args.length !== params.length) this.fail(at, `${name} takes ${params.length} arguments`);
    this.externs.set(name, { name, params, returnType, builtin: true });
    return {
      expr: {
        kind: "call",
        type: returnType,
        callee: name,
        args: args.map((a, i) =>
          params[i]!.kind === "ptr" ? this.pointer(a) : this.valueAs(a, params[i]!),
        ),
      },
    };
  }

  private builtinCall(expr: ts.CallExpression, member: string): Lowered {
    const args = expr.arguments;
    if (member in INT_TYPES) {
      if (args.length !== 1) this.fail(expr, `${member} converts one value`);
      const type = this.intType(member);
      const lowered = this.expression(args[0]!);
      if ("constant" in lowered) return { expr: this.constantAs(lowered.constant, type, args[0]!) };
      const value = this.typed(lowered, args[0]!);
      if (value.type.kind !== "int" && value.type.kind !== "bool")
        this.fail(
          args[0]!,
          `${member} converts an integer or a boolean, not ${typeName(value.type)}`,
        );
      return { expr: this.convertTo(value, type) };
    }
    switch (member) {
      case "likely":
      case "unlikely": {
        if (args.length !== 1) this.fail(expr, `${member} takes one condition`);
        return {
          expr: {
            kind: "expect",
            type: BOOL,
            operand: this.condition(args[0]!),
            expected: member === "likely",
          },
        };
      }
      case "loadUnaligned": {
        const typeArg = expr.typeArguments?.[0];
        if (typeArg === undefined || args.length !== 1)
          this.fail(expr, "loadUnaligned<T>(p) needs T and one pointer");
        const type = this.typeOf(typeArg, "loadUnaligned's type", typeArg);
        if (type.kind !== "int") this.fail(typeArg, "loadUnaligned reads integers");
        return {
          expr: { kind: "load", type, pointer: this.pointer(args[0]!), align: 1, unaligned: true },
        };
      }
      case "memcmp":
        return this.libcCall(
          "memcmp",
          [RAW_POINTER, RAW_POINTER, this.size],
          this.cint,
          args,
          expr,
        );
      case "malloc":
        return this.libcCall("malloc", [this.size], RAW_POINTER, args, expr);
      case "calloc":
        return this.libcCall("calloc", [this.size, this.size], RAW_POINTER, args, expr);
      case "free":
        return this.libcCall("free", [RAW_POINTER], VOID, args, expr);
      case "memset":
        this.fail(expr, "memset is a statement; its result is not available");
      case "nullPointer": {
        const typeArg = expr.typeArguments?.[0];
        if (typeArg === undefined || args.length !== 0) this.fail(expr, "nullPointer<T>() needs T");
        return {
          expr: {
            kind: "null",
            type: { kind: "ptr", to: this.typeOf(typeArg, "the pointee", typeArg) },
          },
        };
      }
      case "addressOf": {
        if (args.length !== 1) this.fail(expr, "addressOf takes one struct reference");
        const value = this.typed(this.expression(args[0]!), args[0]!);
        if (value.type.kind !== "ref") this.fail(args[0]!, "addressOf takes a struct reference");
        // The reference already is the address, and converts to RawPointer
        // where one is expected; keeping its type keeps its alignment.
        return { expr: value };
      }
      case "toAddress": {
        if (args.length !== 1) this.fail(expr, "toAddress takes one pointer");
        return { expr: { kind: "ptrToInt", type: this.uintptr, operand: this.pointer(args[0]!) } };
      }
      case "fromAddress":
      case "cast": {
        const typeArg = expr.typeArguments?.[0];
        if (typeArg === undefined || args.length !== 1)
          this.fail(expr, `${member}<T>(value) needs T`);
        const def = this.structOf(typeArg);
        const type: NativeType =
          def !== null
            ? { kind: "ref", def }
            : { kind: "ptr", to: this.typeOf(typeArg, "the pointee", typeArg) };
        if (member === "cast")
          return { expr: { ...this.pointer(args[0]!), type } as NativeExpr & { type: NativeType } };
        return { expr: { kind: "intToPtr", type, operand: this.valueAs(args[0]!, this.uintptr) } };
      }
    }
    this.fail(expr, `${member} is not supported in native modules yet`);
  }

  /** A pointer or struct reference value. */
  private pointer(expr: ts.Expression): NativeExpr {
    const lowered = this.expression(expr);
    if ("null" in lowered) return { kind: "null", type: RAW_POINTER };
    const value = this.typed(lowered, expr);
    if (value.type.kind !== "ptr" && value.type.kind !== "ref")
      this.fail(expr, `expected a pointer, found ${typeName(value.type)}`);
    return value;
  }

  private methodCall(expr: ts.CallExpression, callee: ts.PropertyAccessExpression): Lowered {
    const receiver = this.typed(this.expression(callee.expression), callee.expression);
    const method = callee.name.text;
    const args = expr.arguments;
    if (receiver.type.kind === "arrayref") {
      switch (method) {
        case "get": {
          if (args.length !== 1) this.fail(expr, "get takes one index");
          const element = this.element(receiver, args[0]!);
          const type = (element.type as { to: NativeType }).to;
          return {
            expr: { kind: "load", type, pointer: element, align: this.addressAlign(element) },
          };
        }
        case "at":
          if (args.length !== 1) this.fail(expr, "at takes one index");
          return { expr: this.element(receiver, args[0]!) };
        case "set":
          this.fail(expr, "set is a statement, not a value");
      }
      this.fail(callee.name, `FixedArray has no method '${method}' in native modules yet`);
    }
    // `cast<S>(p)` is a reference to the struct at p, which tsc types as
    // Pointer<S>: `.get()` names the struct itself, as `*p` does in C.
    if (receiver.type.kind === "ref" && method === "get" && args.length === 0)
      return { expr: receiver };
    if (receiver.type.kind !== "ptr")
      this.fail(callee.expression, `${typeName(receiver.type)} has no methods`);
    const pointee = receiver.type.to;
    switch (method) {
      case "isNull":
        return {
          expr: {
            kind: "binary",
            type: BOOL,
            op: "eq",
            left: receiver,
            right: { kind: "null", type: receiver.type },
          },
        };
      case "get":
        if (pointee === null) this.fail(callee, "a RawPointer has no pointee; cast it first");
        return {
          expr: {
            kind: "load",
            type: pointee,
            pointer: receiver,
            align: alignOfType(pointee, this.pointerBytes),
          },
        };
      case "set":
        this.fail(expr, "Pointer.set is a statement, not a value");
      case "at": {
        if (pointee === null) this.fail(callee, "a RawPointer has no element size; use byteOffset");
        if (args.length !== 1) this.fail(expr, "at takes one index");
        const lowered = this.expression(args[0]!);
        // A constant index is signed, as C's integer literals are.
        const index =
          "constant" in lowered
            ? this.constantAs(lowered.constant, this.intptr, args[0]!)
            : this.typed(lowered, args[0]!);
        if (index.type.kind !== "int") this.fail(args[0]!, "an index is an integer");
        return {
          expr: { kind: "offset", type: receiver.type, pointer: receiver, index, element: pointee },
        };
      }
      case "diff": {
        if (pointee === null) this.fail(callee, "a RawPointer has no element size");
        if (args.length !== 1) this.fail(expr, "diff takes one pointer");
        const other = this.coerce(this.expression(args[0]!), receiver.type, args[0]!);
        return {
          expr: {
            kind: "diff",
            type: this.intptr,
            left: receiver,
            right: other,
            elementSize: sizeOfType(pointee, this.pointerBytes),
          },
        };
      }
    }
    this.fail(callee.name, `Pointer has no method '${method}' in native modules yet`);
  }
}

const BINARY_OPS = new Map<ts.SyntaxKind, NativeBinaryOp>([
  [ts.SyntaxKind.PlusToken, "add"],
  [ts.SyntaxKind.MinusToken, "sub"],
  [ts.SyntaxKind.AsteriskToken, "mul"],
  [ts.SyntaxKind.SlashToken, "div"],
  [ts.SyntaxKind.PercentToken, "rem"],
  [ts.SyntaxKind.AmpersandToken, "and"],
  [ts.SyntaxKind.BarToken, "or"],
  [ts.SyntaxKind.CaretToken, "xor"],
  [ts.SyntaxKind.LessThanLessThanToken, "shl"],
  [ts.SyntaxKind.GreaterThanGreaterThanToken, "shr"],
  [ts.SyntaxKind.EqualsEqualsEqualsToken, "eq"],
  [ts.SyntaxKind.ExclamationEqualsEqualsToken, "ne"],
  [ts.SyntaxKind.LessThanToken, "lt"],
  [ts.SyntaxKind.LessThanEqualsToken, "le"],
  [ts.SyntaxKind.GreaterThanToken, "gt"],
  [ts.SyntaxKind.GreaterThanEqualsToken, "ge"],
]);

const COMPOUND_TO_BINARY = new Map<ts.SyntaxKind, ts.SyntaxKind>([
  [ts.SyntaxKind.PlusEqualsToken, ts.SyntaxKind.PlusToken],
  [ts.SyntaxKind.MinusEqualsToken, ts.SyntaxKind.MinusToken],
  [ts.SyntaxKind.AsteriskEqualsToken, ts.SyntaxKind.AsteriskToken],
  [ts.SyntaxKind.SlashEqualsToken, ts.SyntaxKind.SlashToken],
  [ts.SyntaxKind.PercentEqualsToken, ts.SyntaxKind.PercentToken],
  [ts.SyntaxKind.AmpersandEqualsToken, ts.SyntaxKind.AmpersandToken],
  [ts.SyntaxKind.BarEqualsToken, ts.SyntaxKind.BarToken],
  [ts.SyntaxKind.CaretEqualsToken, ts.SyntaxKind.CaretToken],
  [ts.SyntaxKind.LessThanLessThanEqualsToken, ts.SyntaxKind.LessThanLessThanToken],
  [ts.SyntaxKind.GreaterThanGreaterThanEqualsToken, ts.SyntaxKind.GreaterThanGreaterThanToken],
]);

function isCompoundAssignment(kind: ts.SyntaxKind): boolean {
  return COMPOUND_TO_BINARY.has(kind);
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  const modifiers = (node as { modifiers?: readonly ts.Node[] }).modifiers;
  return modifiers?.some((m) => m.kind === kind) ?? false;
}

function endsInReturn(body: readonly NativeStmt[]): boolean {
  const last = body.at(-1);
  if (last === undefined) return false;
  if (last.kind === "return") return true;
  if (last.kind === "scope") return endsInReturn(last.body);
  if (last.kind === "if") return endsInReturn(last.consequent) && endsInReturn(last.alternative);
  return false;
}

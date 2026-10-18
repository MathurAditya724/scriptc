import * as ts from "../ts7/adapter.js";

/** Whether `node` mentions the constructor's receiver: a `this` or `super`
 * keyword outside nested declarations that bind their own receiver. Arrow
 * functions inherit the receiver, so they stay transparent. */
export function mentionsReceiver(node: ts.Node): boolean {
  let found = false;
  const visit = (child: ts.Node): void => {
    if (found) return;
    if (
      ts.isFunctionExpression(child) ||
      ts.isFunctionDeclaration(child) ||
      ts.isMethodDeclaration(child) ||
      ts.isConstructorDeclaration(child) ||
      ts.isGetAccessor(child) ||
      ts.isSetAccessor(child) ||
      ts.isClassDeclaration(child) ||
      ts.isClassExpression(child)
    ) {
      return;
    }
    if (child.kind === ts.SyntaxKind.ThisKeyword || child.kind === ts.SyntaxKind.SuperKeyword) {
      found = true;
      return;
    }
    child.forEachChild(visit);
  };
  visit(node);
  return found;
}

/** The construction order inputs of one class: its own instance field
 * initializers in declaration order, its parameter property names, the
 * constructor body, and the inherited part of construction. */
export interface ConstructionInputs {
  ctor: ts.ConstructorDeclaration | null;
  /** Own declared fields in declaration order, with their initializers. */
  fields: readonly { name: string; initializer: ts.Expression | undefined }[];
  paramProps: readonly string[];
  derived: boolean;
  /** True when the base class's construction may expose the instance. */
  baseEscapes: boolean;
  /** True for names that are plain instance fields (not accessors). */
  isField: (name: string) => boolean;
  /** The body of the class's own method a `this.m(...)` call runs, when no
   * subclass can override it (TypeScript `private` and `#private`
   * methods, and methods of a class no program class extends); null
   * otherwise. */
  ownMethodBody: (call: ts.CallExpression) => ts.Block | null;
  /** The program class a `new` expression constructs, or null. */
  classOf: (expression: ts.Expression) => ts.ClassLikeDeclaration | null;
  /** The program function declaration a call runs, or null. */
  functionOf: (expression: ts.Expression) => ts.FunctionDeclaration | null;
  /** Inherited fields the base construction assigns before the class's own
   * construction starts. */
  inherited: ReadonlySet<string>;
}

export interface ConstructionEscape {
  /** True when construction may expose the instance to other code (a
   * method call, a callback, an argument, a base constructor that does). */
  escapes: boolean;
  /** Own fields assigned before the first exposure; every own field when
   * construction never exposes the instance. */
  assigned: Set<string>;
}

/** Private helper bodies are followed this deep. */
const HELPER_DEPTH = 3;

const NONE: ReadonlySet<string> = new Set();

/** Built-in constructors that run no program code for inert arguments. */
const INERT_BUILTINS = new Set([
  "Map",
  "Set",
  "Array",
  "Object",
  "Uint8Array",
  "Uint16Array",
  "Uint32Array",
  "Int8Array",
  "Int16Array",
  "Int32Array",
  "Float32Array",
  "Float64Array",
]);

function containsReturn(node: ts.Node): boolean {
  let found = false;
  const visit = (child: ts.Node): void => {
    if (found || ts.isFunctionLike(child) || ts.isClassLikeDeclaration(child)) return;
    if (ts.isReturnStatement(child)) {
      found = true;
      return;
    }
    child.forEachChild(visit);
  };
  node.forEachChild(visit);
  return found;
}

/** Whether `node` mentions the identifier `name` outside nested scopes that
 * declare their own parameter of that name. */
function mentionsName(node: ts.Node, name: string): boolean {
  let found = false;
  const visit = (child: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(child) && child.text === name) {
      found = true;
      return;
    }
    child.forEachChild(visit);
  };
  visit(node);
  return found;
}

function branchStatements(stmt: ts.Statement): readonly ts.Statement[] {
  return ts.isBlock(stmt) ? stmt.statements : [stmt];
}

/** Which own fields construction definitely assigns before the instance can
 * be observed by any other code. A field outside `assigned` may be read
 * while its slot still holds the pre-assignment undefined. */
export function constructionEscape(inputs: ConstructionInputs): ConstructionEscape {
  const assigned = new Set<string>();
  // Fields holding a value that captures the receiver without running code
  // during construction (a closure, an object that only keeps the
  // receiver). Code that reads such a field can reach the receiver.
  const capturing = new Set<string>();
  // Set once a followed function stores the receiver where other code can
  // reach it: from then on, any code that runs may read its fields.
  let leaked = false;
  const stop = (): ConstructionEscape => ({ escapes: true, assigned });
  const readable = (name: string): boolean =>
    (assigned.has(name) || inputs.inherited.has(name)) &&
    !capturing.has(name) &&
    inputs.isField(name);
  const thisMember = (node: ts.Node): node is ts.PropertyAccessExpression =>
    ts.isPropertyAccessExpression(node) && node.expression.kind === ts.SyntaxKind.ThisKeyword;
  // A plain read of an already-assigned field does not expose the instance,
  // nor does a private helper that itself only assigns fields and reads
  // assigned ones; anything else mentioning the receiver might.
  const plainFieldWrite = (
    node: ts.Node,
  ): node is ts.BinaryExpression & {
    left: ts.PropertyAccessExpression;
  } =>
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    thisMember(node.left) &&
    ts.isIdentifier(node.left.name) &&
    inputs.isField(node.left.name.text);
  const exposes = (node: ts.Node, depth: number): boolean => {
    if (leaked && runsCode(node)) return true;
    if (node.kind === ts.SyntaxKind.ThisKeyword || node.kind === ts.SyntaxKind.SuperKeyword)
      return true;
    // `f(this)` with a program function: follow what it does with the
    // receiver.
    if (
      ts.isCallExpression(node) &&
      !thisMember(node.expression) &&
      node.expression.kind !== ts.SyntaxKind.SuperKeyword &&
      !mentionsReceiver(node.expression) &&
      node.arguments.some((arg) => isReceiver(arg, NONE))
    ) {
      const fn = depth < HELPER_DEPTH ? inputs.functionOf(node.expression) : null;
      if (!fn) return true;
      const holding = new Set<number>();
      for (const [i, arg] of node.arguments.entries()) {
        if (isReceiver(arg, NONE)) holding.add(i);
        else if (mentionsReceiver(arg) && exposes(arg, depth)) return true;
      }
      return !followFunction(fn, holding, depth + 1);
    }
    // Writing a plain field does not expose the instance; its value might.
    if (plainFieldWrite(node)) return mentionsReceiver(node.right) && exposes(node.right, depth);
    if (ts.isCallExpression(node) && thisMember(node.expression)) {
      if (node.arguments.some((arg) => mentionsReceiver(arg) && exposes(arg, depth))) return true;
      const body = depth < HELPER_DEPTH ? inputs.ownMethodBody(node) : null;
      if (!body) return true;
      return !followStatements(body.statements, depth + 1, true);
    }
    if (thisMember(node)) return !(ts.isIdentifier(node.name) && readable(node.name.text));
    let found = false;
    node.forEachChild((child) => {
      if (!found && mentionsReceiver(child)) found = exposes(child, depth);
    });
    return found;
  };
  /** Walk straight-line statements; false at the first exposure. In a
   * method body (`helper`), a return ends the walk, and writes after a
   * nested return are not definite. */
  const followStatements = (
    statements: readonly ts.Statement[],
    depth: number,
    helper = false,
  ): boolean => {
    let definite = true;
    for (const stmt of statements) {
      if (leaked && runsCode(stmt)) return false;
      if (helper && ts.isReturnStatement(stmt))
        return !stmt.expression || !mentionsReceiver(stmt) || !exposes(stmt.expression, depth);
      if (helper && containsReturn(stmt)) {
        if (mentionsReceiver(stmt) && exposes(stmt, depth)) return false;
        definite = false;
        continue;
      }
      // An early return leaves later assignments unproven on its path.
      if (ts.isReturnStatement(stmt) || containsReturn(stmt)) return false;
      if (!mentionsReceiver(stmt)) continue;
      if (ts.isExpressionStatement(stmt) && plainFieldWrite(stmt.expression)) {
        const name = stmt.expression.left.name.text;
        if (definite) {
          if (!storeField(name, stmt.expression.right, depth)) return false;
        } else if (mentionsReceiver(stmt.expression.right) && exposes(stmt.expression.right, depth))
          return false;
        continue;
      }
      if (ts.isBlock(stmt)) {
        if (!followStatements(stmt.statements, depth, helper)) return false;
        continue;
      }
      // Both branches of an `if` run straight-line: a field either branch
      // leaves unassigned stays unassigned after it.
      if (ts.isIfStatement(stmt) && !exposes(stmt.expression, depth)) {
        const before = new Set(assigned);
        const leakedBefore = leaked;
        if (!followStatements(branchStatements(stmt.thenStatement), depth, helper)) return false;
        const afterThen = new Set(assigned);
        const capturedThen = new Set(capturing);
        const leakedThen = leaked;
        leaked = leakedBefore;
        assigned.clear();
        for (const name of before) assigned.add(name);
        if (
          stmt.elseStatement &&
          !followStatements(branchStatements(stmt.elseStatement), depth, helper)
        )
          return false;
        for (const name of [...assigned]) if (!afterThen.has(name)) assigned.delete(name);
        for (const name of capturedThen) capturing.add(name);
        leaked ||= leakedThen;
        continue;
      }
      // Any other statement (a loop, a declaration, a check that throws)
      // that only reads assigned fields and writes fields does not expose
      // the instance; the fields it writes are not definitely assigned.
      if (!exposes(stmt, depth)) continue;
      return false;
    }
    return true;
  };
  /** `this.name = value`: false when evaluating `value` may expose the
   * receiver. A value that only captures it marks the field capturing. */
  const storeField = (name: string, value: ts.Expression, depth: number): boolean => {
    if (mentionsReceiver(value)) {
      const captures = capturesReceiver(value, depth);
      if (!captures && exposes(value, depth)) return false;
      if (captures) capturing.add(name);
      else capturing.delete(name);
    } else capturing.delete(name);
    assigned.add(name);
    return true;
  };
  /** Whether a program function given the receiver at the `holding`
   * argument positions runs no code on it: it reads assigned fields through
   * it, writes fields with inert values, and passes it on to functions that
   * do the same. Storing it anywhere else leaks it (see `leaked`). */
  const followFunction = (
    fn: ts.FunctionDeclaration,
    holding: ReadonlySet<number>,
    depth: number,
  ): boolean => {
    if (!fn.body || fn.asteriskToken || depth >= HELPER_DEPTH) return false;
    if (ts.getModifiers(fn)?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) return false;
    const held = new Set<string>();
    for (const index of holding) {
      const param = fn.parameters[index];
      if (!param || !ts.isIdentifier(param.name) || param.dotDotDotToken) return false;
      held.add(param.name.text);
    }
    let keeps = true;
    const visit = (child: ts.Node): void => {
      if (!keeps) return;
      if (leaked && (ts.isCallExpression(child) || ts.isNewExpression(child)) && runsCode(child)) {
        keeps = false;
        return;
      }
      if (ts.isFunctionLike(child) && child !== fn) {
        if ([...held].some((name) => mentionsName(child, name))) keeps = false;
        return;
      }
      if (!ts.isIdentifier(child) || !held.has(child.text)) {
        child.forEachChild(visit);
        return;
      }
      const parent = child.parent;
      if (ts.isPropertyAccessExpression(parent) && parent.expression === child) {
        const name = parent.name.text;
        const outer = parent.parent;
        if (
          ts.isBinaryExpression(outer) &&
          outer.left === parent &&
          outer.operatorToken.kind === ts.SyntaxKind.EqualsToken
        ) {
          // A field write through the receiver: its value must run no code.
          if (!inputs.isField(name) || !inert(outer.right)) keeps = false;
          return;
        }
        if (ts.isCallExpression(outer) && outer.expression === parent) {
          keeps = false;
          return;
        }
        if (!readable(name)) keeps = false;
        return;
      }
      if (ts.isCallExpression(parent) && parent.arguments.includes(child)) {
        const callee = depth + 1 < HELPER_DEPTH ? inputs.functionOf(parent.expression) : null;
        const passed = new Set<number>();
        parent.arguments.forEach((arg, i) => {
          if (isReceiver(arg, held)) passed.add(i);
        });
        if (!callee || !followFunction(callee, passed, depth + 1)) keeps = false;
        return;
      }
      // Stored anywhere else (a property of another object, a variable, a
      // return value): code that runs later may reach it.
      leaked = true;
    };
    for (const stmt of fn.body.statements) visit(stmt);
    return keeps;
  };
  /** Whether evaluating `node` may run code: a call, a tagged template, or
   * a construction that is not inert. */
  const runsCode = (node: ts.Node): boolean => {
    let runs = false;
    const visit = (child: ts.Node): void => {
      if (runs) return;
      if (ts.isFunctionLike(child) || ts.isClassLikeDeclaration(child)) return;
      if (ts.isCallExpression(child) || ts.isTaggedTemplateExpression(child)) {
        runs = true;
        return;
      }
      if (ts.isNewExpression(child)) {
        if (!inert(child)) runs = true;
        return;
      }
      child.forEachChild(visit);
    };
    visit(node);
    return runs;
  };
  /** A value whose evaluation runs no code: literals, identifiers, reads,
   * array and object literals of such values, and constructions whose
   * constructors only store such values (`new Map()`, a program class that
   * only assigns its fields). */
  const inert = (node: ts.Node, depth = 0): boolean => {
    let e = node as ts.Expression;
    while (ts.isParenthesizedExpression(e)) e = e.expression;
    if (ts.isNewExpression(e)) {
      if (!(e.arguments ?? []).every((arg) => inert(arg, depth))) return false;
      const cls = inputs.classOf(e.expression);
      if (!cls) return ts.isIdentifier(e.expression) && INERT_BUILTINS.has(e.expression.text);
      return inertConstruction(cls, depth + 1);
    }
    let pure = true;
    const visit = (child: ts.Node): void => {
      if (!pure) return;
      if (
        ts.isCallExpression(child) ||
        ts.isTaggedTemplateExpression(child) ||
        ts.isFunctionLike(child) ||
        ts.isClassLikeDeclaration(child) ||
        child.kind === ts.SyntaxKind.ThisKeyword
      ) {
        pure = false;
        return;
      }
      if (ts.isNewExpression(child)) {
        if (!inert(child, depth)) pure = false;
        return;
      }
      child.forEachChild(visit);
    };
    visit(e);
    return pure;
  };
  /** A class whose construction only stores inert values in its own fields. */
  const inertConstruction = (cls: ts.ClassLikeDeclaration, depth: number): boolean => {
    if (depth >= HELPER_DEPTH) return false;
    for (const member of cls.members) {
      if (
        ts.isPropertyDeclaration(member) &&
        member.initializer &&
        !ts.getModifiers(member)?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword) &&
        !inert(member.initializer, depth)
      )
        return false;
    }
    const base = cls.heritageClauses?.find(
      (clause) => clause.token === ts.SyntaxKind.ExtendsKeyword,
    )?.types[0]?.expression;
    const baseClass = base ? inputs.classOf(base) : null;
    if (base && (!baseClass || !inertConstruction(baseClass, depth + 1))) return false;
    const ctor = cls.members.find(
      (member): member is ts.ConstructorDeclaration =>
        ts.isConstructorDeclaration(member) && member.body !== undefined,
    );
    for (const stmt of ctor?.body?.statements ?? []) {
      const expression = ts.isExpressionStatement(stmt) ? stmt.expression : null;
      if (
        expression &&
        ts.isCallExpression(expression) &&
        expression.expression.kind === ts.SyntaxKind.SuperKeyword &&
        expression.arguments.every((arg) => inert(arg, depth))
      )
        continue;
      if (
        expression &&
        ts.isBinaryExpression(expression) &&
        expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        thisMember(expression.left) &&
        inert(expression.right, depth)
      )
        continue;
      return false;
    }
    return true;
  };
  /** A closure, or `new C(...)` whose construction only keeps the receiver
   * it is given: the value holds the receiver, and no code runs on it now. */
  const capturesReceiver = (value: ts.Expression, depth: number): boolean => {
    let e = value;
    while (ts.isParenthesizedExpression(e)) e = e.expression;
    if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) return true;
    return ts.isNewExpression(e) && keepsReceiver(e, new Set(), depth);
  };
  /** Whether constructing `expr` only stores the receiver it receives as a
   * bare argument (and reads fields already assigned through it), so that
   * no code runs on the receiver. `held` names the enclosing constructor's
   * parameters that hold the receiver. */
  const keepsReceiver = (
    expr: ts.NewExpression,
    held: ReadonlySet<string>,
    depth: number,
  ): boolean => {
    if (depth >= HELPER_DEPTH) return false;
    const cls = inputs.classOf(expr.expression);
    if (!cls) return false;
    const holding = new Set<number>();
    for (const [i, arg] of (expr.arguments ?? []).entries()) {
      if (isReceiver(arg, held)) holding.add(i);
      else if (!argumentKeepsReceiver(arg, held, depth)) return false;
    }
    return constructorKeepsReceiver(cls, holding, depth + 1);
  };
  /** The receiver itself: `this`, or a parameter holding it. */
  const isReceiver = (node: ts.Expression, held: ReadonlySet<string>): boolean => {
    let e = node;
    while (ts.isParenthesizedExpression(e)) e = e.expression;
    return e.kind === ts.SyntaxKind.ThisKeyword || (ts.isIdentifier(e) && held.has(e.text));
  };
  /** An argument that does not use the receiver beyond reading assigned
   * fields through it. */
  const argumentKeepsReceiver = (
    node: ts.Node,
    held: ReadonlySet<string>,
    depth: number,
  ): boolean => {
    if (held.size === 0) return !mentionsReceiver(node) || !exposes(node, depth);
    let keeps = true;
    const visit = (child: ts.Node): void => {
      if (!keeps) return;
      if (
        ts.isPropertyAccessExpression(child) &&
        isReceiver(child.expression, held) &&
        ts.isIdentifier(child.name) &&
        readable(child.name.text) &&
        !(ts.isCallExpression(child.parent) && child.parent.expression === child)
      )
        return;
      if (ts.isIdentifier(child) && held.has(child.text)) {
        keeps = false;
        return;
      }
      if (child.kind === ts.SyntaxKind.ThisKeyword || child.kind === ts.SyntaxKind.SuperKeyword) {
        keeps = false;
        return;
      }
      if (ts.isFunctionLike(child) || ts.isClassLikeDeclaration(child)) {
        if (mentionsReceiver(child) || [...held].some((name) => mentionsName(child, name)))
          keeps = false;
        return;
      }
      child.forEachChild(visit);
    };
    visit(node);
    return keeps;
  };
  /** Whether `cls`'s construction keeps the receiver passed at the
   * `holding` argument positions without running code on it: its
   * constructor stores those parameters in fields, passes them on to a
   * base or another construction that does the same, and reads only
   * assigned fields through them; nothing else in it mentions its own
   * instance. */
  const constructorKeepsReceiver = (
    cls: ts.ClassLikeDeclaration,
    holding: ReadonlySet<number>,
    depth: number,
  ): boolean => {
    // Without the receiver, a construction cannot reach it.
    if (holding.size === 0) return true;
    if (depth >= HELPER_DEPTH) return false;
    for (const member of cls.members) {
      if (
        ts.isPropertyDeclaration(member) &&
        !ts.getModifiers(member)?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword) &&
        member.initializer &&
        mentionsReceiver(member.initializer)
      )
        return false;
    }
    const base = cls.heritageClauses?.find(
      (clause) => clause.token === ts.SyntaxKind.ExtendsKeyword,
    )?.types[0]?.expression;
    const baseClass = base ? inputs.classOf(base) : null;
    if (base && !baseClass) return holding.size === 0;
    const ctor = cls.members.find(
      (member): member is ts.ConstructorDeclaration =>
        ts.isConstructorDeclaration(member) && member.body !== undefined,
    );
    if (!ctor) return baseClass ? constructorKeepsReceiver(baseClass, holding, depth + 1) : true;
    const held = new Set<string>();
    for (const index of holding) {
      const param = ctor.parameters[index];
      if (!param || !ts.isIdentifier(param.name) || param.dotDotDotToken) return false;
      held.add(param.name.text);
    }
    for (const stmt of ctor.body!.statements) {
      const expression = ts.isExpressionStatement(stmt) ? stmt.expression : null;
      if (
        expression &&
        ts.isCallExpression(expression) &&
        expression.expression.kind === ts.SyntaxKind.SuperKeyword
      ) {
        const passed = new Set<number>();
        for (const [i, arg] of expression.arguments.entries()) {
          if (isReceiver(arg, held) && arg.kind !== ts.SyntaxKind.ThisKeyword) passed.add(i);
          else if (!argumentKeepsReceiver(arg, held, depth)) return false;
        }
        if (!baseClass) return false;
        if (!constructorKeepsReceiver(baseClass, passed, depth + 1)) return false;
        continue;
      }
      if (
        expression &&
        ts.isBinaryExpression(expression) &&
        expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        thisMember(expression.left)
      ) {
        const value = expression.right;
        let e = value;
        while (ts.isParenthesizedExpression(e)) e = e.expression;
        if (isReceiver(e, held) && e.kind !== ts.SyntaxKind.ThisKeyword) continue;
        if (ts.isNewExpression(e) && !mentionsReceiver(e) && keepsReceiver(e, held, depth))
          continue;
        if (mentionsReceiver(value) || !argumentKeepsReceiver(value, held, depth)) return false;
        continue;
      }
      if (mentionsReceiver(stmt) || [...held].some((name) => mentionsName(stmt, name)))
        return false;
    }
    return true;
  };
  const ownInitializers = (): boolean => {
    for (const name of inputs.paramProps) assigned.add(name);
    for (const field of inputs.fields) {
      if (!field.initializer) continue;
      if (!storeField(field.name, field.initializer, 0)) return false;
    }
    return true;
  };
  const statements = inputs.ctor?.body?.statements ?? [];
  let index = 0;
  if (inputs.derived) {
    // Own initializers run when super() returns. A base construction that
    // exposes the instance exposes it before any own field is assigned.
    for (; index < statements.length; index++) {
      const stmt = statements[index]!;
      const isSuper =
        ts.isExpressionStatement(stmt) &&
        ts.isCallExpression(stmt.expression) &&
        stmt.expression.expression.kind === ts.SyntaxKind.SuperKeyword;
      if (isSuper) {
        if (stmt.expression.arguments.some((arg) => mentionsReceiver(arg))) return stop();
        break;
      }
      // super() nested inside other statements: keep the analysis simple.
      if (mentionsReceiver(stmt)) return stop();
    }
    if (inputs.ctor?.body && index >= statements.length) return stop();
    if (inputs.baseEscapes) return stop();
    index++;
  }
  if (!ownInitializers()) return stop();
  if (!followStatements(statements.slice(index), 0)) return stop();
  return { escapes: false, assigned };
}

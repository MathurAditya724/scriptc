import { afterAll, expect, test } from "vitest";
import * as ts from "../ts7/adapter.js";
import { closeSourceParser, parseSourceFile } from "../ts7/source-parser-node.js";
import { constructionEscape, mentionsReceiver } from "./construction-escapes.js";

afterAll(closeSourceParser);

function analyze(
  source: string,
  options: {
    derived?: boolean;
    baseEscapes?: boolean;
    /** Follow non-private methods too, as for a class nothing extends. */
    unextended?: boolean;
    inherited?: string[];
  } = {},
) {
  const file = parseSourceFile("classes.ts", source, "ts");
  let decl: ts.ClassDeclaration | undefined;
  const classes = new Map<string, ts.ClassDeclaration>();
  const functions = new Map<string, ts.FunctionDeclaration>();
  ts.walkPreorder(file, (node) => {
    if (ts.isFunctionDeclaration(node) && node.name && node.body)
      functions.set(node.name.text, node);
    if (!ts.isClassDeclaration(node)) return;
    if (!decl) decl = node;
    if (node.name) classes.set(node.name.text, node);
  });
  if (!decl) throw new Error("fixture has no class");
  const cls = decl;
  const ctor = cls.members.find(ts.isConstructorDeclaration) ?? null;
  const fields = cls.members
    .filter(ts.isPropertyDeclaration)
    .map((member) => ({ name: member.name.getText(), initializer: member.initializer }));
  const fieldNames = new Set(fields.map((field) => field.name));
  return constructionEscape({
    ctor,
    fields,
    paramProps: [],
    derived: options.derived ?? false,
    baseEscapes: options.baseEscapes ?? false,
    isField: (name) => fieldNames.has(name) || (options.inherited ?? []).includes(name),
    inherited: new Set(options.inherited ?? []),
    classOf: (expression) =>
      ts.isIdentifier(expression) ? (classes.get(expression.text) ?? null) : null,
    functionOf: (expression) =>
      ts.isIdentifier(expression) ? (functions.get(expression.text) ?? null) : null,
    ownMethodBody: (call) => {
      if (!ts.isPropertyAccessExpression(call.expression)) return null;
      const name = call.expression.name.text;
      const method = cls.members.find(
        (member): member is ts.MethodDeclaration =>
          ts.isMethodDeclaration(member) && member.name.getText() === name,
      );
      const isPrivate =
        method !== undefined &&
        (ts.isPrivateIdentifier(method.name) ||
          (ts.getModifiers(method)?.some((m) => m.kind === ts.SyntaxKind.PrivateKeyword) ?? false));
      return isPrivate || (method !== undefined && options.unextended)
        ? (method.body ?? null)
        : null;
    },
  });
}

const sorted = (set: Set<string>): string[] => [...set].sort();

test("assignments before any exposure are proven", () => {
  const result = analyze(`
    class A {
      a: B; b: B; c: B;
      constructor() {
        this.a = new B();
        this.b = make(this.a);
        log("no receiver here");
        this.c = new B();
        this.report();
      }
    }`);
  expect(result.escapes).toBe(true);
  expect(sorted(result.assigned)).toEqual(["a", "b", "c"]);
});

test("a call that receives the instance stops the proof", () => {
  const result = analyze(`
    class A {
      seen: boolean; box: B;
      constructor() {
        this.seen = check(this);
        this.box = new B();
      }
    }`);
  expect(result.escapes).toBe(true);
  expect(sorted(result.assigned)).toEqual([]);
});

test("method calls, callbacks and reads of unassigned fields expose the instance", () => {
  for (const body of [
    "this.describe(); this.box = new B();",
    "const f = () => this.box; this.box = new B();",
    "this.other = this.box; this.box = new B();",
    "if (flag) this.describe(); this.box = new B();",
  ]) {
    const result = analyze(`class A { box: B; other: B; constructor() { ${body} } }`);
    expect(result.escapes, body).toBe(true);
    expect(result.assigned.has("box"), body).toBe(false);
  }
});

test("initializers run in order before the constructor body", () => {
  const result = analyze(`
    class A {
      first = new B();
      second = this.first;
      third = this.compute();
      fourth = new B();
      constructor() { this.fifth = new B(); }
    }`);
  expect(result.escapes).toBe(true);
  expect(sorted(result.assigned)).toEqual(["first", "second"]);
});

test("private helpers that only assign fields are followed", () => {
  const result = analyze(`
    class A {
      a!: B; b!: B; c: B;
      constructor() {
        this.setup();
        this.c = new B();
      }
      private setup(): void {
        this.a = new B();
        this.#more();
      }
      #more(): void {
        this.b = this.a;
      }
    }`);
  expect(result.escapes).toBe(false);
  expect(sorted(result.assigned)).toEqual(["a", "b", "c"]);
});

test("public helpers, helpers that return early, and early returns stop the proof", () => {
  for (const source of [
    "class A { a!: B; constructor() { this.setup(); } setup(): void { this.a = new B(); } }",
    "class A { a!: B; constructor() { this.setup(); this.report(); } private setup(): void { if (x) return; this.a = new B(); } }",
    "class A { a!: B; constructor() { if (x) return; this.a = new B(); } }",
  ]) {
    const result = analyze(source);
    expect(result.escapes, source).toBe(true);
    expect(result.assigned.has("a"), source).toBe(false);
  }
  // A helper's early return ends the helper: its later writes are not
  // definite, and the helper itself exposes nothing.
  const helper = analyze(
    "class A { a!: B; constructor() { this.setup(); } private setup(): void { if (x) return; this.a = new B(); } }",
  );
  expect(helper.escapes).toBe(false);
  expect(helper.assigned.has("a")).toBe(false);
});

test("derived classes inherit the base constructor's exposure", () => {
  const source = `
    class D {
      box: B;
      constructor() {
        super();
        this.box = new B();
      }
    }`;
  expect(analyze(source, { derived: true }).escapes).toBe(false);
  const exposed = analyze(source, { derived: true, baseEscapes: true });
  expect(exposed.escapes).toBe(true);
  expect(sorted(exposed.assigned)).toEqual([]);
  // Without a constructor, construction is the implicit super call.
  expect(analyze("class D { box = new B(); }", { derived: true, baseEscapes: true }).escapes).toBe(
    true,
  );
  expect(sorted(analyze("class D { box = new B(); }", { derived: true }).assigned)).toEqual([
    "box",
  ]);
});

test("nested functions with their own receiver are opaque", () => {
  const file = parseSourceFile(
    "nested.ts",
    "const f = function () { return this; }; const g = () => this;",
    "ts",
  );
  const found: boolean[] = [];
  ts.walkPreorder(file, (node) => {
    if (ts.isVariableDeclaration(node) && node.initializer)
      found.push(mentionsReceiver(node.initializer));
  });
  expect(found).toEqual([false, true]);
});

test("branches that only write fields assign what both branches assign", () => {
  const result = analyze(`
    class A {
      a: number; b: number; c: number;
      constructor(flag: boolean) {
        if (flag) { this.a = 1; this.b = 2; } else { this.a = 3; }
        for (let i = 0; i < 2; i++) this.c = i;
      }
    }`);
  expect(result.escapes).toBe(false);
  expect(sorted(result.assigned)).toEqual(["a"]);
});

test("helper calls that may not run leave their fields unassigned", () => {
  const result = analyze(`
    class A {
      a!: B; b!: B; c!: B; d!: B; e!: B;
      constructor(n: number, flag: boolean) {
        for (let i = 0; i < n; i++) this.setA();
        flag && this.setB();
        const c = flag ? this.setC() : null;
        this.e = this.setD();
      }
      private setA(): void { this.a = new B(); }
      private setB(): void { this.b = new B(); }
      private setC(): void { this.c = new B(); }
      private setD(): B { this.d = new B(); return this.d; }
    }`);
  expect(result.escapes).toBe(false);
  expect(sorted(result.assigned)).toEqual(["d", "e"]);
});

test("a branch that overwrites a capturing field leaves it capturing", () => {
  const result = analyze(`
    class A {
      f!: () => number; a!: number;
      constructor(flag: boolean) {
        this.f = () => this.a;
        if (flag) this.f = () => 1;
        const g = this.f;
        this.a = 1;
      }
    }`);
  expect(result.escapes).toBe(true);
  expect(sorted(result.assigned)).toEqual(["f"]);
});

test("a helper call that may not run leaves an overwritten field capturing", () => {
  const result = analyze(`
    class A {
      f!: () => number; a!: number;
      constructor(n: number) {
        this.f = () => this.a;
        for (let i = 0; i < n; i++) this.reset();
        const g = this.f;
        this.a = 1;
      }
      private reset(): void { this.f = () => 1; }
    }`);
  expect(result.escapes).toBe(true);
  expect(sorted(result.assigned)).toEqual(["f"]);
});

test("own methods are followed only for classes nothing extends", () => {
  const source = `
    class A {
      a: number; b: number;
      constructor() {
        this.a = 1;
        this.b = this.read();
      }
      read(): number { if (this.a > 0) return this.a; return 0; }
    }`;
  expect(analyze(source).escapes).toBe(true);
  const followed = analyze(source, { unextended: true });
  expect(followed.escapes).toBe(false);
  expect(sorted(followed.assigned)).toEqual(["a", "b"]);
});

test("free functions given the receiver are followed", () => {
  const reads = analyze(`
    class A {
      a: number; b: number;
      constructor() { this.a = 1; this.b = twice(this); }
    }
    function twice(o: A): number { return o.a * 2; }`);
  expect(reads.escapes).toBe(false);
  const early = analyze(`
    class A {
      a: number; b: number;
      constructor() { this.a = twice(this); this.b = 1; }
    }
    function twice(o: A): number { return o.b * 2; }`);
  expect(early.escapes).toBe(true);
  expect(sorted(early.assigned)).toEqual([]);
});

test("a stored receiver makes later code an exposure", () => {
  const result = analyze(`
    class A {
      a: number; b: number;
      constructor() { keep(this); this.a = 1; report(); this.b = 2; }
    }
    function keep(o: A): void { last = o; }`);
  expect(result.escapes).toBe(true);
  expect(sorted(result.assigned)).toEqual(["a"]);
});

test("constructions that only store the receiver capture it", () => {
  const result = analyze(`
    class A {
      v: V; a: number; b: number;
      constructor() {
        this.v = new V(this);
        this.a = 1;
        this.b = this.v.read();
      }
    }
    class V {
      owner: A;
      constructor(owner: A) { this.owner = owner; }
      read(): number { return this.owner.b; }
    }`);
  expect(result.escapes).toBe(true);
  expect(sorted(result.assigned)).toEqual(["a", "v"]);
});

test("a construction that reads an unassigned field through the receiver exposes it", () => {
  const result = analyze(`
    class A {
      v: V; a: number;
      constructor() { this.v = new V(this); this.a = 1; }
    }
    class V {
      seen: number;
      constructor(owner: A) { this.seen = owner.a; }
    }`);
  expect(result.escapes).toBe(true);
  expect(sorted(result.assigned)).toEqual([]);
});

test("closures stored in fields do not run during construction", () => {
  const result = analyze(`
    class A {
      f = () => this.a;
      a: number;
      constructor() { this.a = 1; }
    }`);
  expect(result.escapes).toBe(false);
  expect(sorted(result.assigned)).toEqual(["a", "f"]);
});

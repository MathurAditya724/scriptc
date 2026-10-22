/* The type-only exports of an opted-in package's declaration files.
 *
 * An opted-in package compiles from its JavaScript, and the checker types
 * the package from it: the package's shipped .d.ts is hidden from
 * resolution (npmStaticFsShadow). Values keep their JavaScript types, but a
 * type that exists only in the .d.ts (an interface, a type alias, an enum
 * used as a type) has no declaration in the JavaScript, so a program's
 * `import type { Options } from "pkg"` resolved to `any`. TypeScript and
 * Node see the .d.ts types.
 *
 * The package's declaration files stay available as copies under another
 * name (`<file>.scriptc-types.d.ts`, relative specifiers respelled to the
 * copies), and the runtime entry gains a JSDoc typedef per type-only export
 * that names the declaration in the copy:
 *
 *   / ** @template T @typedef {import("./main.scriptc-types").Box<T>} Box * /
 *
 * Classes and values keep the JavaScript's own declarations. */
import * as ts from "./ts7/syntax.js";
import { tokenStartOfNode } from "./ts7/node-functions.js";

/** The suffix that replaces `.d.ts` in a copy's name. */
export const NPM_STATIC_TYPES_SUFFIX = ".scriptc-types.d.ts";

/** A type-only declaration: its name, its type parameters' names and their
 * JSDoc @template tag bodies. */
export interface NpmStaticTypeDeclaration {
  name: string;
  params: readonly string[];
  templates: readonly string[];
}

/** What a declaration file declares and re-exports, by exported name. */
export interface NpmStaticDeclarationExports {
  /** Exported interfaces, type aliases and enums, with their parameters. */
  types: readonly NpmStaticTypeDeclaration[];
  /** Exported classes, functions, variables and namespaces: names the
   * JavaScript declares itself, or that are not type-only. */
  values: readonly string[];
  /** `export { local as exported } from "specifier"` and local
   * `export { a, b }` (specifier null). */
  named: readonly { exported: string; local: string; specifier: string | null }[];
  /** `export * from "specifier"`. */
  stars: readonly string[];
}

function isExported(node: ts.Node): boolean {
  const modifiers = (node as { modifiers?: { nodes: readonly ts.Node[] } }).modifiers?.nodes ?? [];
  return modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

function templatesOf(sf: ts.SourceFile, params: readonly ts.TypeParameterDeclaration[]): string[] {
  const text = (n: ts.Node): string => sf.text.slice(tokenStartOfNode(n), n.end);
  return params.map((p) => {
    const name = p.name.text;
    const constraint = p.constraint === undefined ? "" : `{${text(p.constraint)}} `;
    return p.defaultType === undefined
      ? `${constraint}${name}`
      : `${constraint}[${name}=${text(p.defaultType)}]`;
  });
}

/** The exports of one declaration file. */
export function npmStaticDeclarationExports(sf: ts.SourceFile): NpmStaticDeclarationExports {
  const types: NpmStaticTypeDeclaration[] = [];
  const values: string[] = [];
  const named: { exported: string; local: string; specifier: string | null }[] = [];
  const stars: string[] = [];
  const localTypes = new Map<string, NpmStaticTypeDeclaration>();
  const localValues = new Set<string>();
  for (const stmt of sf.statements.nodes) {
    const exported = isExported(stmt);
    if (ts.isInterfaceDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt)) {
      const params = stmt.typeParameters?.nodes ?? [];
      const decl = {
        name: stmt.name.text,
        params: params.map((p) => p.name.text),
        templates: templatesOf(sf, params),
      };
      localTypes.set(decl.name, decl);
      if (exported) types.push(decl);
    } else if (ts.isEnumDeclaration(stmt)) {
      const decl: NpmStaticTypeDeclaration = { name: stmt.name.text, params: [], templates: [] };
      localTypes.set(decl.name, decl);
      if (exported) types.push(decl);
    } else if (
      ts.isClassDeclaration(stmt) ||
      ts.isFunctionDeclaration(stmt) ||
      ts.isModuleDeclaration(stmt)
    ) {
      const name = stmt.name !== undefined && ts.isIdentifier(stmt.name) ? stmt.name.text : null;
      if (name !== null) {
        localValues.add(name);
        if (exported) values.push(name);
      }
    } else if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations.nodes) {
        if (!ts.isIdentifier(d.name)) continue;
        localValues.add(d.name.text);
        if (exported) values.push(d.name.text);
      }
    } else if (ts.isExportDeclaration(stmt)) {
      const specifier =
        stmt.moduleSpecifier !== undefined && ts.isStringLiteral(stmt.moduleSpecifier)
          ? stmt.moduleSpecifier.text
          : null;
      const clause = stmt.exportClause;
      if (clause === undefined) {
        if (specifier !== null) stars.push(specifier);
      } else if (ts.isNamedExports(clause)) {
        for (const e of clause.elements.nodes) {
          const exportedName = e.name.text;
          const local = (e.propertyName ?? e.name).text;
          named.push({ exported: exportedName, local, specifier });
        }
      }
    }
  }
  // Local `export { a as b }` of the file's own declarations.
  const resolvedNamed: typeof named = [];
  for (const n of named) {
    if (n.specifier !== null) {
      resolvedNamed.push(n);
      continue;
    }
    const local = localTypes.get(n.local);
    if (local !== undefined) types.push({ ...local, name: n.exported });
    else if (localValues.has(n.local)) values.push(n.exported);
  }
  return { types, values, named: resolvedNamed, stars };
}

/** The relative module specifiers of a declaration file's imports, exports
 * and `import("...")` types, with their spans. */
function relativeSpecifiers(sf: ts.SourceFile): { start: number; end: number; text: string }[] {
  const found: { start: number; end: number; text: string }[] = [];
  const add = (literal: ts.Node | undefined): void => {
    if (literal === undefined || !ts.isStringLiteral(literal)) return;
    if (!literal.text.startsWith("./") && !literal.text.startsWith("../")) return;
    found.push({ start: tokenStartOfNode(literal), end: literal.end, text: literal.text });
  };
  ts.walkPreorder(sf, (n) => {
    if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) add(n.moduleSpecifier);
    else if (ts.isImportTypeNode(n) && ts.isLiteralTypeNode(n.argument)) add(n.argument.literal);
    return undefined;
  });
  return found;
}

/** The relative specifiers a declaration file names. */
export function npmStaticDeclarationSpecifiers(sf: ts.SourceFile): string[] {
  return relativeSpecifiers(sf).map((s) => s.text);
}

/** The declaration file's text with each relative specifier `rename`
 * answers respelled (quoted with the original's quote). */
export function npmStaticDeclarationCopy(
  sf: ts.SourceFile,
  rename: (specifier: string) => string | null,
): string {
  const spans = relativeSpecifiers(sf).sort((a, b) => a.start - b.start);
  let text = "";
  let at = 0;
  for (const span of spans) {
    const renamed = rename(span.text);
    if (renamed === null) continue;
    const quote = sf.text[span.start] ?? '"';
    text += sf.text.slice(at, span.start) + quote + renamed + quote;
    at = span.end;
  }
  return text + sf.text.slice(at);
}

/** The JSDoc typedefs that re-export `types` from the copy at `specifier`. */
export function npmStaticTypedefBlock(
  types: readonly NpmStaticTypeDeclaration[],
  specifier: string,
): string {
  const lines: string[] = [];
  for (const t of types) {
    const args = t.params.length === 0 ? "" : `<${t.params.join(", ")}>`;
    lines.push("/**");
    for (const tag of t.templates) lines.push(` * @template ${tag}`);
    lines.push(` * @typedef {import(${JSON.stringify(specifier)}).${t.name}${args}} ${t.name}`);
    lines.push(" */");
  }
  return lines.join("\n");
}

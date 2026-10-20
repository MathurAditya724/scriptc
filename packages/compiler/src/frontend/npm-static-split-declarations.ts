/* A minifier merges consecutive declarations, so a module's requires and
 * the bindings read from them share one statement:
 *
 *   var rp = require_fs(), minimatch = require_minimatch(),
 *     Minimatch = minimatch.Minimatch, EE = require("events").EventEmitter;
 *
 * Require bindings and member aliases of them are modeled per statement,
 * so a top-level declaration that mixes require() initializers with other
 * declarators is respelled as one declaration statement per declarator,
 * in the same order and on the same lines. Evaluation is unchanged:
 * declarators of one statement already run left to right.
 *
 * A declarator that also stores its value as an export
 * (`t = exports.tokens = {}`, semver's spelling) becomes the declaration
 * followed by the export of the binding (`var t = {}; exports.tokens = t;`):
 * the value is evaluated once and both names hold it, as before, while the
 * export is a plain member export of the binding. */
import * as ts from "./ts7/syntax.js";
import { applyEdits, unparen, type Edit } from "./npm-static-bundled-chunks.js";

/** True when the text may hold such a declaration (a cheap probe). */
export function mayMergeRequireDeclarations(source: string): boolean {
  return (
    (source.includes("require(") &&
      /\b(?:var|let|const)\s[^;]*(?:,[^;]*require\(|require\([^;]*,)/.test(source)) ||
    /=\s*(?:module\.)?exports2?\.[\w$]+\s*=[^=]/.test(source)
  );
}

/** `exports.X = E` / `module.exports.X = E`: the export target, or null. */
function exportStoreOf(expr: ts.Expression): ts.PropertyAccessExpression | null {
  const e = unparen(expr);
  if (!ts.isBinaryExpression(e) || e.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return null;
  const left = e.left;
  if (!ts.isPropertyAccessExpression(left) || !ts.isIdentifier(left.name)) return null;
  const obj = left.expression;
  if (ts.isIdentifier(obj) && obj.text === "exports") return left;
  if (
    ts.isPropertyAccessExpression(obj) &&
    ts.isIdentifier(obj.expression) &&
    obj.expression.text === "module" &&
    obj.name.text === "exports"
  )
    return left;
  return null;
}

function isRequireValue(expr: ts.Expression): boolean {
  const e = unparen(expr);
  if (!ts.isCallExpression(e) || !ts.isIdentifier(e.expression)) return false;
  const args = e.arguments.nodes;
  if (e.expression.text === "require")
    return (
      args.length === 1 && (ts.isStringLiteral(args[0]!) || ts.isNoSubstitutionTemplateLiteral(args[0]!))
    );
  if (e.expression.text === "__toESM")
    return (args.length === 1 || args.length === 2) && isRequireValue(args[0]!);
  return false;
}

/** The module text with each mixed top-level declaration split, or null
 * when there is none. */
export function splitRequireDeclarations(sf: ts.SourceFile): string | null {
  const edits: Edit[] = [];
  for (const stmt of sf.statements.nodes) {
    if (!ts.isVariableStatement(stmt)) continue;
    if (stmt.modifiers !== undefined && stmt.modifiers.nodes.length > 0) continue;
    const list = stmt.declarationList;
    const decls = list.declarations.nodes;
    const flags = list.flags;
    const keyword =
      (flags & ts.NodeFlags.Const) !== 0 ? "const" : (flags & ts.NodeFlags.Let) !== 0 ? "let" : "var";
    const stores = decls.map((d) =>
      ts.isIdentifier(d.name) && d.initializer !== undefined ? exportStoreOf(d.initializer) : null,
    );
    if (stores.some((st) => st !== null)) {
      // Respell the whole statement: each declarator its own declaration,
      // an export store after its binding's declaration.
      const parts = decls.map((d, i) => {
        const store = stores[i] ?? null;
        if (store === null) return `${keyword} ${d.getText(sf)};`;
        const name = (d.name as ts.Identifier).text;
        const value = (unparen(d.initializer!) as ts.BinaryExpression).right.getText(sf);
        return `${keyword} ${name} = ${value}; ${store.getText(sf)} = ${name};`;
      });
      edits.push({ start: stmt.getStart(sf), end: stmt.getEnd(), text: parts.join(" ") });
      continue;
    }
    if (decls.length < 2) continue;
    if (!decls.some((d) => d.initializer !== undefined && isRequireValue(d.initializer))) continue;
    for (let i = 1; i < decls.length; i++) {
      const start = decls[i - 1]!.getEnd();
      const end = decls[i]!.getStart(sf);
      if (!sf.text.slice(start, end).includes(",")) return null;
      edits.push({ start, end, text: `; ${keyword} ` });
    }
  }
  if (edits.length === 0) return null;
  return applyEdits(sf.text, 0, sf.text.length, edits);
}

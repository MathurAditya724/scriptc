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
 * declarators of one statement already run left to right. */
import * as ts from "./ts7/syntax.js";
import { applyEdits, unparen, type Edit } from "./npm-static-bundled-chunks.js";

/** True when the text may hold such a declaration (a cheap probe). */
export function mayMergeRequireDeclarations(source: string): boolean {
  return (
    source.includes("require(") &&
    /\b(?:var|let|const)\s[^;]*(?:,[^;]*require\(|require\([^;]*,)/.test(source)
  );
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
    if (decls.length < 2) continue;
    if (!decls.some((d) => d.initializer !== undefined && isRequireValue(d.initializer))) continue;
    const flags = list.flags;
    const keyword =
      (flags & ts.NodeFlags.Const) !== 0 ? "const" : (flags & ts.NodeFlags.Let) !== 0 ? "let" : "var";
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

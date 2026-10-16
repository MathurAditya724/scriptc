import * as ts from "../../ts7/adapter.js";
import { type Lowerer } from "../lowerer.js";
import { isJsSourceFile } from "../../program.js";
import { builtinModuleFnOf } from "../surfaces.js";
import { registerHttpClientFnBinding } from "../lower-server.js";

/** Compile-time util.promisify projections. The immutable result binding
 * owns no runtime slot: calls rewrite to the target's promise lowering,
 * while value uses remain explicit fences. Unsupported targets report at
 * the declaration, where their identity is still visible. */
export function isPromisifyCall(lowerer: Lowerer, init: ts.Expression): ts.CallExpression | null {
  let e: ts.Expression = init;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  if (!ts.isCallExpression(e) || e.questionDotToken) return null;
  // `promisify(...)` over a named import, `util.promisify(...)` over a
  // namespace or default import.
  const bi = ts.isIdentifier(e.expression)
    ? lowerer.builtinImportOf(e.expression)
    : ts.isPropertyAccessExpression(e.expression)
      ? lowerer.builtinMemberOf(e.expression)
      : null;
  if (!bi || bi.module !== "util" || bi.member !== "promisify") return null;
  return e;
}

/** Immutable aliases of table-backed builtin functions. The alias is a
 * compile-time call target, so direct calls keep the builtin's validated
 * lowering without materializing a JavaScript function object. Value
 * uses remain fenced until an escaping closure adapter exists. */
export function registerBuiltinCallableAlias(
  lowerer: Lowerer,
  nameNode: ts.Node,
  init: ts.Expression | undefined,
): boolean {
  if (!ts.isIdentifier(nameNode) || !init) return false;
  let targetExpr = init;
  while (ts.isParenthesizedExpression(targetExpr)) targetExpr = targetExpr.expression;
  if (!ts.isIdentifier(targetExpr)) return false;
  const sourceSymbol = lowerer.resolveValueSymbol(targetExpr);
  const existing = sourceSymbol ? lowerer.staticCallables.get(sourceSymbol) : undefined;
  const target =
    existing?.kind === "builtin-function"
      ? { module: existing.module, member: existing.member }
      : lowerer.builtinImportOf(targetExpr);
  if (!target || !builtinModuleFnOf(lowerer, target.module, target.member)) return false;
  // These checked native functions retain a runtime slot in JavaScript so
  // aliases can escape without narrowing their arguments to string.
  if (
    isJsSourceFile(nameNode.getSourceFile()) &&
    target.module === "util" &&
    ["stripVTControlCharacters", "toUSVString", "isDeepStrictEqual", "styleText"].includes(
      target.member,
    )
  )
    return false;
  if (lowerer.checker.getCallSignatures(lowerer.typeOf(nameNode)).length === 0) return false;
  const symbol = lowerer.checker.getSymbolAtLocation(nameNode);
  if (!symbol) return false;
  lowerer.staticCallables.set(symbol, {
    kind: "builtin-function",
    module: target.module,
    member: target.member,
  });
  return true;
}

export function registerPromisifiedBuiltinDecl(
  lowerer: Lowerer,
  nameNode: ts.Node,
  init: ts.Expression | undefined,
): boolean {
  if (!init) return false;
  // The OTHER special const-binding form this decl hook serves: the
  // `const requestFn = tls ? https.request : http.request` client
  // ternary (lower-server.ts's registry) — calls through it lower as
  // the runtime-secure http client.
  if (registerHttpClientFnBinding(lowerer, nameNode, init)) return true;
  const e = isPromisifyCall(lowerer, init);
  if (!e) return false;
  const argNode = e.arguments.length === 1 ? e.arguments[0]! : null;
  // `promisify(exec)` over a named import, or `promisify(cp.exec)` over a
  // namespace import.
  const target = !argNode
    ? null
    : ts.isIdentifier(argNode)
      ? lowerer.builtinImportOf(argNode)
      : ts.isPropertyAccessExpression(argNode)
        ? lowerer.builtinMemberOf(argNode)
        : null;
  const projection =
    target?.module === "child_process" && target.member === "execFile"
      ? { kind: "promisified-exec-file" as const }
      : target?.module === "child_process" && target.member === "exec"
        ? { kind: "promisified-exec" as const }
        : target?.module === "fs" && target.member === "readFile"
          ? { kind: "promisified-builtin" as const, module: "fs/promises", member: "readFile" }
          : null;
  if (!projection) {
    lowerer.noLowering(
      "util.promisify of this target",
      argNode ?? e,
      "child_process.exec, child_process.execFile and fs.readFile are the supported targets",
    );
  }
  const symbol = lowerer.checker.getSymbolAtLocation(nameNode);
  if (symbol) lowerer.staticCallables.set(symbol, projection);
  return true;
}

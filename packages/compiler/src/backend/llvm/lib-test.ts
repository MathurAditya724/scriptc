import { InternalCompilerError } from "../../errors.js";
import type { LibCallExpr, LlValue, LlvmEmitterContext } from "./expr-context.js";
import { abiValue, callRuntime, finishRuntimeCall, ptr } from "./lib-abi.js";
import { f64Lit } from "./common.js";

export function emitTestLibCall(host: LlvmEmitterContext, e: LibCallExpr): LlValue {
  const args = e.args.map((arg) => host.emitExpr(arg)),
    a = args.map((arg) => abiValue(host, arg));
  host.usesTimers = true;
  switch (e.fn) {
    case "test.register":
      host.moveTemp(args[3]!);
      return finishRuntimeCall(host, e, "scr_test_register", a);
    case "test.registerEmpty":
      return finishRuntimeCall(host, e, "scr_test_register", [
        ...a.slice(0, 3),
        ptr(),
        ...a.slice(3),
      ]);
    case "test.suite":
      host.moveTemp(args[3]!);
      return finishRuntimeCall(host, e, "scr_test_suite", a);
    case "test.hook":
      host.moveTemp(args[1]!);
      return finishRuntimeCall(host, e, "scr_test_hook", a);
    case "test.sub":
      host.moveTemp(args[4]!);
      return finishRuntimeCall(host, e, "scr_test_sub", a);
    case "test.subEmpty": {
      const promise = callRuntime(host, "scr_test_sub", "ptr", [
        ...a.slice(0, 4),
        ptr(),
        { type: "double", name: f64Lit(0) },
        a[4]!,
      ]);
      callRuntime(host, "scr_promise_release", "void", [ptr(promise)]);
      return { name: "", type: e.type };
    }
    case "test.ctxSkip":
      return finishRuntimeCall(host, e, "scr_test_ctx_skip", a);
    case "test.ctxTodo":
      return finishRuntimeCall(host, e, "scr_test_ctx_todo", a);
    case "test.ctxDiagnostic":
      return finishRuntimeCall(host, e, "scr_test_ctx_diagnostic", a);
    case "test.ctxName":
      return finishRuntimeCall(host, e, "scr_test_ctx_name", a);
    case "test.ctxFullName":
      return finishRuntimeCall(host, e, "scr_test_ctx_full_name", a);
    case "test.ctxHook":
      host.moveTemp(args[2]!);
      return finishRuntimeCall(host, e, "scr_test_ctx_hook", a);
    case "test.ctxPlan":
      return finishRuntimeCall(host, e, "scr_test_ctx_plan", a);
    case "test.ctxCount":
      return finishRuntimeCall(host, e, "scr_test_ctx_count", a);
    default:
      throw new InternalCompilerError(`unhandled test call ${e.fn}`);
  }
}

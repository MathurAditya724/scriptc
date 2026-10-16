import { expect, test } from "vitest";
import { F64, STRING, VOID, type IrModule } from "../../ir/ir.js";
import { emitLlvmModule } from "./emitter.js";

const loc = { file: "publish-walkers.ts", start: 0, end: 1 };
const node = { kind: "object" as const, className: "Node" };
const kids = { kind: "array" as const, elem: node };

const mod: IrModule = {
  irVersion: 16,
  sourceFile: loc.file,
  entry: "main",
  functions: [
    {
      name: "main",
      params: [{ localId: "root", name: "root", type: node }],
      returnType: VOID,
      locals: [{ id: "root", name: "root", type: node, mutable: false }],
      body: [
        {
          kind: "exprStmt",
          expr: {
            kind: "intrinsic",
            name: "threads.publish",
            args: [{ kind: "varRef", localId: "root", type: node, loc }],
            type: node,
            loc,
          },
          loc,
        },
      ],
      loc,
    },
  ],
  classes: [
    {
      name: "Node",
      fields: [
        { name: "parent", type: node },
        { name: "name", type: STRING },
        { name: "kids", type: kids },
        { name: "weight", type: F64 },
      ],
      methods: [],
      loc,
    },
  ],
};

/** The walker of class Node. */
function walker(llvm: string): string {
  return llvm.split(/^define /m).find((fn) => fn.includes("; publish object:Node")) ?? "";
}

test("publication walkers mark and push inline, with the runtime for the rest", () => {
  const fn = walker(emitLlvmModule(mod, { pointerBits: 64, objectAudit: false }));
  // The mark: the count, the refusal and the log's room in ScrPub's leading
  // fields, then the 16-byte log entry and SIZE_MAX.
  expect(fn).toContain("getelementptr inbounds ptr, ptr %ctx, i32 6");
  expect(fn).toContain("icmp ult i64 %mrc, 4294967294");
  expect(fn).toContain("getelementptr inbounds { ptr, i32, i32 }, ptr %mlog, i64 %mlogged");
  expect(fn).toContain("store i64 -1, ptr %o");
  // Anything else goes through scr_pub_mark.
  expect(fn).toMatch(/call zeroext i1 @scr_pub_mark\(ptr %ctx, ptr %o, i1 (true|false), i32 4\)/);
  // A string is a leaf, marked at once; other references go on the stack,
  // through scr_pub_push only when it is full.
  expect(fn).toMatch(/call void @scr_pub_str_fn\(ptr %v\d+, ptr %ctx\)/);
  expect(fn).toMatch(/^grow\d+:\n {2}call void @scr_pub_push\(ptr %ctx/m);
  expect(fn).toMatch(/store ptr %v\d+, ptr %slot\d+/);
});

test("RC-audit builds mark through scr_pub_mark, which records each object's kind", () => {
  const fn = walker(emitLlvmModule(mod, { pointerBits: 64 }));
  expect(fn).not.toContain("{ ptr, i32, i32 }");
  expect(fn).toMatch(
    /%m = call zeroext i1 @scr_pub_mark\(ptr %ctx, ptr %o, i1 (true|false), i32 4\)/,
  );
});

test("32-bit walkers log the count without the 64-bit escapes", () => {
  const fn = walker(emitLlvmModule(mod, { pointerBits: 32, objectAudit: false }));
  expect(fn).not.toContain("4294967294");
  expect(fn).toContain("getelementptr inbounds { ptr, i32, i32 }, ptr %mlog, i32 %mlogged");
});

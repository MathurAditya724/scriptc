import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { compile } from "../src/index.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function emit(source: string): Promise<string> {
  const outDir = await mkdtemp(join(tmpdir(), "scriptc-await-call-"));
  directories.push(outDir);
  const entry = join(outDir, "main.ts");
  await writeFile(entry, source);
  const outPath = join(outDir, "program.ll");
  const result = await compile(entry, { entry, outDir, outPath, outputKind: "llvm" });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  return readFile(outPath, "utf8");
}

function definition(llvm: string, symbol: string): string {
  const match = new RegExp(`^define internal [^\\n]*@${symbol}\\([^]*?^}`, "m").exec(llvm);
  expect(match, symbol).not.toBeNull();
  return match![0];
}

const source = `
const cache = new Map<number, number>();
async function leaf(x: number): Promise<number> {
  const hit = cache.get(x);
  return hit ?? x + 1;
}
async function middle(x: number): Promise<number> {
  const y = await leaf(x);
  return y * 2;
}
async function main(): Promise<void> {
  const pending = leaf(1);
  let sum = await middle(2);
  sum += await pending;
  console.log(sum);
}
void main();
`;

test("awaiting a direct call to a body that never suspends skips the promise", async () => {
  const llvm = await emit(source);
  expect(definition(llvm, "sc_f_middle")).toContain("call double @sc_aw_leaf(double");
  const entry = definition(llvm, "sc_aw_leaf");
  expect(entry).toContain("call double @sc_f_leaf(double %a0)");
  expect(entry).toContain("call void @scr_async_inline_exit(ptr %frame)");
  // The clean result takes the await's microtask turn and returns directly;
  // only the throw path builds the rejected promise.
  const clean = entry.slice(entry.indexOf("clean:"), entry.indexOf("thrown:"));
  expect(clean).toContain("call void @scr_await_hop()");
  expect(clean).not.toContain("@scr_promise_new");
  expect(entry.slice(entry.indexOf("thrown:"))).toContain("call void @scr_promise_reject_pending");
});

test("awaiting a direct call to a suspending body spawns and awaits in one call", async () => {
  const llvm = await emit(source);
  const main = definition(llvm, "sc_f_main");
  expect(main).toContain("call double @sc_aw_middle(double");
  // A call whose promise is kept keeps the promise-returning entry.
  expect(main).toContain("call ptr @sc_as_leaf(double");
  expect(definition(llvm, "sc_aw_middle")).toContain(
    "call double @scr_async_spawn_await_f64(ptr @sc_tr_middle, ptr %ap)",
  );
  // middle awaits, so it keeps its fiber.
  expect(definition(llvm, "sc_as_middle")).toContain("@scr_async_spawn(");
});

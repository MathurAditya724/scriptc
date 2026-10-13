import { describe, expect, test } from "vitest";
import {
  compileRegexMatcher,
  regexLiteralBailReason,
  regexLiteralCompiles,
} from "./regex-matchers.js";

function body(pattern: string, flags = "", vector = true): string {
  const code = compileRegexMatcher("m", pattern, flags, "i64", vector);
  if (code === null) throw new Error(`/${pattern}/${flags} did not compile`);
  return code.lines.join("\n");
}

describe("regex literal matcher subset", () => {
  test.each([
    ['^(\\d+\\.\\d+\\.\\d+\\.\\d+) - - \\[([^\\]]+)\\] "(\\w+) ([^ ?"]+)(?:\\?([^ "]*))?$', ""],
    ["curl|bot|spider", "i"],
    ["\\d+", "g"],
    ["(?<year>\\d{4})-(?<month>\\d\\d)", ""],
    ["[\\b\\-\\]\\\\.]+", ""],
    ["\\x41\\u0042\\0\\t\\/\\-", ""],
    ["a{2,}?b{0,3}c*?", "y"],
    ["^\\s*$", "m"],
    ["\\bfoo\\B", "su"],
    ["[^]", ""],
  ])("/%s/%s compiles", (pattern, flags) => {
    expect(regexLiteralBailReason(pattern, flags)).toBe("");
  });

  test.each([
    ["(a)\\1", ""],
    ["a(?=b)", ""],
    ["a(?!b)", ""],
    ["(?<=a)b", ""],
    ["\\k<n>(?<n>a)", ""],
    ["\\p{L}", "u"],
    ["é", ""],
    ["\\u00e9", ""],
    ["[é]", "i"],
    ["\\cA", ""],
    ["\\01", ""],
    ["a{", ""],
    ["]", ""],
    ["\\a", ""],
    ["(?i:a)", ""],
    ["a{1,200000}", ""],
    ["^*", ""],
  ])("/%s/%s keeps the interpreter", (pattern, flags) => {
    expect(regexLiteralCompiles(pattern, flags)).toBe(false);
  });

  test("large patterns keep the interpreter", () => {
    expect(regexLiteralCompiles("(?:ab|cd)".repeat(20), "")).toBe(true);
    expect(regexLiteralCompiles("(?:ab|cd)".repeat(200), "")).toBe(false);
  });
});

describe("regex literal matcher code", () => {
  test("reports its capture count for a negative length", () => {
    expect(body("(a)(?:b)(?<c>c)")).toContain("ret i32 3");
  });

  test("a single possible first byte searches with memchr", () => {
    const code = compileRegexMatcher("m", "x\\d+", "g", "i64", true);
    expect(code?.decls).toContain("declare ptr @memchr(ptr, i32, i64)");
    expect(code?.lines.join("\n")).toContain("call ptr @memchr(ptr %from, i32 120, i64 %rest.w)");
  });

  test("a sticky pattern makes one attempt", () => {
    const text = body("\\d+", "y");
    expect(text).not.toContain("@memchr");
    expect(text).toMatch(/attempt_fail:\n {2}br label %nomatch/);
  });

  test("a non-multiline ^ attempts only position 0", () => {
    expect(body("^ab")).toContain("br i1 %a0, label %attempt, label %nomatch");
  });

  test("first-character sets and long runs use 16-byte scans", () => {
    const text = body("\\d+");
    expect(text).toContain("load <16 x i8>");
    expect(text).toContain("@llvm.cttz.i16");
    expect(body("\\d+", "", false)).not.toContain("<16 x i8>");
    // A bounded count below 32 stays scalar.
    expect(body("a\\d{1,3}")).not.toContain("<16 x i8>");
  });

  test("loops no continuation can share push no backtrack entries", () => {
    // \d+ then a dot; [^\]]+ then ]; the run at the end of the pattern.
    expect(body("\\d+\\.\\d+")).not.toContain("@scr_regex_stack_grow");
    expect(body("\\[[^\\]]+\\]")).not.toContain("@scr_regex_stack_grow");
    expect(body("a.*")).not.toContain("@scr_regex_stack_grow");
    // .* followed by b can give characters back.
    expect(body("a.*b")).toContain("@scr_regex_stack_grow");
    // $ is zero-width: \d+ may still give back before it.
    expect(body("\\d+$")).toContain("@scr_regex_stack_grow");
  });

  test("class tests use compares for few ranges and a table otherwise", () => {
    expect(body("[a-c]x")).not.toContain("constant [128 x i8]");
    expect(body("[aceg]x")).toContain("private unnamed_addr constant [128 x i8]");
  });

  test("case folding closes ASCII letters only", () => {
    // [^a]/i excludes both cases: compares 0-64, 66-96, 98-127 as ranges.
    const text = body("x[^a]", "i");
    expect(text).toContain("icmp ule i32");
    expect(text).not.toContain("constant [128 x i8]");
  });
});

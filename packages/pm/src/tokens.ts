// A small JavaScript/TypeScript tokenizer and the scanners built on it:
// token-normalized comparison of emitted JS (DESIGN.md §6.3 "equivalent"),
// import specifier extraction (missing-module detection), and exported-name
// collection (the declaration surface check, §6.4).
//
// It is deliberately approximate: regex literals are recognized by the
// previous significant token, and template literals are kept as raw chunks.
// Both sides of every comparison go through the same tokenizer.

export type TokenKind = "id" | "num" | "str" | "tpl" | "re" | "punct";

export interface Token {
  kind: TokenKind;
  value: string;
}

const REGEX_AFTER_KEYWORD = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "case",
  "do",
  "else",
  "yield",
  "await",
]);

const PUNCTUATORS = [
  ">>>=",
  "...",
  "===",
  "!==",
  "**=",
  "<<=",
  ">>=",
  ">>>",
  "&&=",
  "||=",
  "??=",
  "=>",
  "==",
  "!=",
  "<=",
  ">=",
  "&&",
  "||",
  "??",
  "?.",
  "++",
  "--",
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "&=",
  "|=",
  "^=",
  "**",
  "<<",
  ">>",
];

function isIdStart(c: string): boolean {
  return /[A-Za-z_$\u0080-￿]/.test(c);
}

function isIdPart(c: string): boolean {
  return /[A-Za-z0-9_$\u0080-￿]/.test(c);
}

function regexAllowed(prev: Token | undefined): boolean {
  if (prev === undefined) return true;
  if (prev.kind === "punct") return prev.value !== ")" && prev.value !== "]" && prev.value !== "}";
  if (prev.kind === "id") return REGEX_AFTER_KEYWORD.has(prev.value);
  return false;
}

export function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  // Brace depths at which an open template literal resumes.
  const templateStack: number[] = [];
  let braceDepth = 0;
  let i = 0;
  const n = src.length;
  const scanTemplate = (start: number): number => {
    // `start` is just after "`" or "}"; returns the index after the chunk.
    let j = start;
    while (j < n) {
      const c = src[j] as string;
      if (c === "\\") {
        j += 2;
      } else if (c === "`") {
        tokens.push({ kind: "tpl", value: src.slice(start, j) });
        return j + 1;
      } else if (c === "$" && src[j + 1] === "{") {
        tokens.push({ kind: "tpl", value: `${src.slice(start, j)}\${` });
        templateStack.push(braceDepth);
        braceDepth += 1;
        return j + 2;
      } else {
        j += 1;
      }
    }
    tokens.push({ kind: "tpl", value: src.slice(start) });
    return n;
  };
  while (i < n) {
    const c = src[i] as string;
    if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "﻿" || c === " ") {
      i += 1;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < n && src[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (c === "#" && i === 0 && src[1] === "!") {
      while (i < n && src[i] !== "\n") i += 1;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
      tokens.push({ kind: "str", value: src.slice(i + 1, j) });
      i = j + 1;
      continue;
    }
    if (c === "`") {
      i = scanTemplate(i + 1);
      continue;
    }
    if (isIdStart(c) || (c === "#" && i + 1 < n && isIdStart(src[i + 1] as string))) {
      let j = i + 1;
      while (j < n && isIdPart(src[j] as string)) j += 1;
      tokens.push({ kind: "id", value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      let j = i + 1;
      while (j < n && /[0-9A-Za-z_.]/.test(src[j] as string)) {
        if ((src[j] === "e" || src[j] === "E") && (src[j + 1] === "+" || src[j + 1] === "-")) {
          j += 2;
        } else {
          j += 1;
        }
      }
      tokens.push({ kind: "num", value: src.slice(i, j).replace(/_/g, "") });
      i = j;
      continue;
    }
    if (c === "/" && regexAllowed(tokens[tokens.length - 1])) {
      let j = i + 1;
      let inClass = false;
      while (j < n && src[j] !== "\n") {
        const d = src[j] as string;
        if (d === "\\") {
          j += 2;
          continue;
        }
        if (d === "[") inClass = true;
        else if (d === "]") inClass = false;
        else if (d === "/" && !inClass) break;
        j += 1;
      }
      j += 1;
      while (j < n && isIdPart(src[j] as string)) j += 1;
      tokens.push({ kind: "re", value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (c === "{") {
      braceDepth += 1;
      tokens.push({ kind: "punct", value: c });
      i += 1;
      continue;
    }
    if (c === "}") {
      braceDepth -= 1;
      const top = templateStack[templateStack.length - 1];
      if (top !== undefined && top === braceDepth) {
        templateStack.pop();
        i = scanTemplate(i + 1);
        continue;
      }
      tokens.push({ kind: "punct", value: c });
      i += 1;
      continue;
    }
    let matched = c;
    for (const p of PUNCTUATORS) {
      if (src.startsWith(p, i)) {
        matched = p;
        break;
      }
    }
    tokens.push({ kind: "punct", value: matched });
    i += matched.length;
  }
  return tokens;
}

// ── normalization for emitted-JS comparison ─────────────────────────────

function isPunct(t: Token | undefined, value: string): boolean {
  return t !== undefined && t.kind === "punct" && t.value === value;
}

function isId(t: Token | undefined, value: string): boolean {
  return t !== undefined && t.kind === "id" && t.value === value;
}

/** Index just past the statement starting at `start` (its `;` at depth 0). */
function statementEnd(tokens: Token[], start: number): number {
  let depth = 0;
  for (let i = start; i < tokens.length; i += 1) {
    const t = tokens[i] as Token;
    if (t.kind !== "punct") continue;
    if (t.value === "(" || t.value === "[" || t.value === "{") depth += 1;
    else if (t.value === ")" || t.value === "]" || t.value === "}") depth -= 1;
    else if (t.value === ";" && depth === 0) return i + 1;
  }
  return tokens.length;
}

/** Remove emitter boilerplate that varies between TypeScript versions and
 * build tools but carries no program behavior: the "use strict" prologue,
 * helper definitions (`var __importDefault = ...`), the `__esModule` marker,
 * `exports.a = exports.b = void 0` pre-declarations, the `(0, ns.f)(...)`
 * call form, quote style, semicolons and trailing commas. */
export function normalizeEmit(input: Token[]): Token[] {
  const out: Token[] = [];
  // `exports.f = f;` for exported function declarations moved from after the
  // declaration to the module top between TypeScript versions; these are
  // compared as a sorted set at the end instead of in place.
  const exportAssignments: string[] = [];
  let i = 0;
  let depth = 0;
  while (i < input.length) {
    const t = input[i] as Token;
    if (depth === 0) {
      if (
        isId(t, "exports") &&
        isPunct(input[i + 1], ".") &&
        input[i + 2]?.kind === "id" &&
        isPunct(input[i + 3], "=") &&
        input[i + 4]?.kind === "id" &&
        isPunct(input[i + 5], ";")
      ) {
        exportAssignments.push(`${(input[i + 2] as Token).value}=${(input[i + 4] as Token).value}`);
        i += 6;
        continue;
      }
      if (t.kind === "str" && t.value === "use strict" && isPunct(input[i + 1], ";")) {
        i += 2;
        continue;
      }
      if (
        (isId(t, "var") || isId(t, "const") || isId(t, "let")) &&
        input[i + 1]?.kind === "id" &&
        (input[i + 1] as Token).value.startsWith("__") &&
        isPunct(input[i + 2], "=")
      ) {
        i = statementEnd(input, i);
        continue;
      }
      if (
        isId(t, "Object") &&
        isPunct(input[i + 1], ".") &&
        isId(input[i + 2], "defineProperty") &&
        isPunct(input[i + 3], "(") &&
        isId(input[i + 4], "exports") &&
        input[i + 6]?.kind === "str" &&
        (input[i + 6] as Token).value === "__esModule"
      ) {
        i = statementEnd(input, i);
        continue;
      }
      if (isId(t, "exports") && isVoidPredeclaration(input, i)) {
        i = statementEnd(input, i);
        continue;
      }
    }
    // (0, a.b)( → a.b(
    if (isPunct(t, "(") && input[i + 1]?.kind === "num" && (input[i + 1] as Token).value === "0") {
      if (isPunct(input[i + 2], ",")) {
        let j = i + 3;
        while (input[j]?.kind === "id" && isPunct(input[j + 1], ".")) j += 2;
        if (input[j]?.kind === "id" && isPunct(input[j + 1], ")") && j > i + 3) {
          for (let k = i + 3; k <= j; k += 1) out.push(input[k] as Token);
          i = j + 2;
          continue;
        }
      }
    }
    if (t.kind === "punct") {
      if (t.value === "(" || t.value === "[" || t.value === "{") depth += 1;
      else if (t.value === ")" || t.value === "]" || t.value === "}") depth -= 1;
      if (t.value === ";") {
        i += 1;
        continue;
      }
      if (t.value === ",") {
        const nextTok = input[i + 1];
        if (isPunct(nextTok, ")") || isPunct(nextTok, "]") || isPunct(nextTok, "}")) {
          i += 1;
          continue;
        }
      }
    }
    if (t.kind === "str") {
      out.push({ kind: "str", value: t.value.replace(/\\(['"])/g, "$1") });
    } else {
      out.push(t);
    }
    i += 1;
  }
  exportAssignments.sort();
  for (const assignment of exportAssignments)
    out.push({ kind: "punct", value: `exports:${assignment}` });
  return out;
}

function isVoidPredeclaration(tokens: Token[], start: number): boolean {
  let i = start;
  while (isId(tokens[i], "exports") && isPunct(tokens[i + 1], ".") && isPunct(tokens[i + 3], "=")) {
    i += 4;
  }
  return i > start && isId(tokens[i], "void") && tokens[i + 1]?.value === "0";
}

export interface Difference {
  index: number;
  expected: string;
  actual: string;
}

/** First difference between two normalized token streams, or null. */
export function firstDifference(published: Token[], emitted: Token[]): Difference | null {
  const n = Math.max(published.length, emitted.length);
  for (let i = 0; i < n; i += 1) {
    const a = published[i];
    const b = emitted[i];
    if (a !== undefined && b !== undefined && a.kind === b.kind && a.value === b.value) continue;
    return { index: i, expected: context(published, i), actual: context(emitted, i) };
  }
  return null;
}

function context(tokens: Token[], at: number): string {
  return tokens
    .slice(Math.max(0, at - 4), at + 6)
    .map((t) => t.value)
    .join(" ");
}

// ── imports ──────────────────────────────────────────────────────────────

export interface ImportRef {
  specifier: string;
  typeOnly: boolean;
}

/** Module specifiers of import/export-from statements, `import("x")`,
 * `require("x")` and `import x = require("x")`. */
export function importsOf(tokens: Token[]): ImportRef[] {
  const out: ImportRef[] = [];
  let typeOnly = false;
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i] as Token;
    if (t.kind !== "id") continue;
    const prev = tokens[i - 1];
    const memberAccess = isPunct(prev, ".") || isPunct(prev, "?.");
    if ((t.value === "import" || t.value === "export") && !memberAccess) {
      const nextTok = tokens[i + 1];
      typeOnly = isId(nextTok, "type") && !isPunct(tokens[i + 2], "(");
      if (t.value === "import" && nextTok?.kind === "str") {
        out.push({ specifier: nextTok.value, typeOnly: false });
      } else if (t.value === "import" && isPunct(nextTok, "(") && tokens[i + 2]?.kind === "str") {
        out.push({ specifier: (tokens[i + 2] as Token).value, typeOnly: false });
      }
      continue;
    }
    if (t.value === "from" && tokens[i + 1]?.kind === "str") {
      out.push({ specifier: (tokens[i + 1] as Token).value, typeOnly: typeOnly });
      typeOnly = false;
      continue;
    }
    if (
      t.value === "require" &&
      !memberAccess &&
      isPunct(tokens[i + 1], "(") &&
      tokens[i + 2]?.kind === "str" &&
      isPunct(tokens[i + 3], ")")
    ) {
      out.push({ specifier: (tokens[i + 2] as Token).value, typeOnly: false });
    }
  }
  return out;
}

// ── exported names ───────────────────────────────────────────────────────

const DECL_KEYWORDS = new Set([
  "function",
  "class",
  "const",
  "let",
  "var",
  "enum",
  "namespace",
  "module",
  "interface",
  "type",
]);
const DECL_MODIFIERS = new Set(["declare", "abstract", "async", "default"]);

export interface ExportScan {
  names: string[];
  /** Specifiers of `export * from "x"` statements, to be followed. */
  stars: string[];
}

/** Exported names declared at the top level of one module. */
export function exportsOf(tokens: Token[]): ExportScan {
  const names: string[] = [];
  const stars: string[] = [];
  let depth = 0;
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i] as Token;
    if (t.kind === "punct") {
      if (t.value === "{") depth += 1;
      else if (t.value === "}") depth -= 1;
      continue;
    }
    if (depth !== 0 || !isId(t, "export")) continue;
    if (isPunct(tokens[i - 1], ".")) continue;
    let j = i + 1;
    const first = tokens[j];
    if (isPunct(first, "=")) {
      names.push("export=");
      continue;
    }
    if (isId(first, "as") && isId(tokens[j + 1], "namespace")) continue;
    if (isId(first, "default")) {
      names.push("default");
      continue;
    }
    if (isId(first, "type") && isPunct(tokens[j + 1], "{")) j += 1;
    if (isId(first, "import") && tokens[j + 1]?.kind === "id") {
      names.push((tokens[j + 1] as Token).value);
      continue;
    }
    if (isPunct(tokens[j], "*")) {
      if (isId(tokens[j + 1], "as") && tokens[j + 2]?.kind === "id") {
        names.push((tokens[j + 2] as Token).value);
      } else if (isId(tokens[j + 1], "from") && tokens[j + 2]?.kind === "str") {
        stars.push((tokens[j + 2] as Token).value);
      }
      continue;
    }
    if (isPunct(tokens[j], "{")) {
      let k = j + 1;
      while (k < tokens.length && !isPunct(tokens[k], "}")) {
        const tok = tokens[k] as Token;
        if (tok.kind === "id" && tok.value !== "type") {
          const after = tokens[k + 1];
          if (isId(after, "as") && tokens[k + 2] !== undefined) {
            names.push((tokens[k + 2] as Token).value);
            k += 3;
            continue;
          }
          names.push(tok.value);
        }
        k += 1;
      }
      continue;
    }
    while (tokens[j]?.kind === "id" && DECL_MODIFIERS.has((tokens[j] as Token).value)) j += 1;
    if (isId(tokens[j], "const") && isId(tokens[j + 1], "enum")) j += 1;
    const keyword = tokens[j];
    if (keyword?.kind === "id" && DECL_KEYWORDS.has(keyword.value)) {
      let k = j + 1;
      if (isPunct(tokens[k], "*")) k += 1;
      const nameTok = tokens[k];
      if (nameTok?.kind === "id") names.push(nameTok.value);
    }
  }
  return { names: names, stars: stars };
}

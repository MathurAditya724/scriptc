// charCodeAt scans in counted for loops over ASCII strings, Latin-1 and BMP
// text, surrogate pairs and lone surrogates, empty strings, neighbors at
// i - 1 and i + 1, loops that stop early or read past the end, strings built
// by concatenation and slicing, a scan of a slice local, two strings read at
// one index, a string rebound inside or after the loop, nested scans and a
// module-level scan.

function spaces(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 32) n++;
  return n;
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

function rises(s: string): number {
  let n = 0;
  for (let i = 1; i < s.length; i++) if (s.charCodeAt(i) > s.charCodeAt(i - 1)) n++;
  return n;
}

function peaks(s: string): number {
  let n = 0;
  for (let i = 1; i < s.length - 1; i++) {
    const c = s.charCodeAt(i);
    if (c > s.charCodeAt(i - 1) && c > s.charCodeAt(i + 1)) n++;
  }
  return n;
}

function firstDigit(s: string): number {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 48 && c <= 57) return i;
  }
  return -1;
}

function pastEnd(s: string): string {
  let sum = 0;
  for (let i = 0; i <= s.length; i++) sum += s.charCodeAt(i);
  return String(sum);
}

function sameAt(a: string, b: string): number {
  let n = 0;
  const end = Math.min(a.length, b.length);
  for (let i = 0; i < end; i++) if (a.charCodeAt(i) === b.charCodeAt(i)) n++;
  return n;
}

function stepped(s: string): number {
  let h = 7;
  for (let i = s.length - 1; i >= 0; i -= 2) h = (h * 33) ^ s.charCodeAt(i);
  return h;
}

function slicedScan(s: string, from: number, to: number): number {
  const piece = s.slice(from, to);
  let n = piece.length;
  for (let i = 0; i < piece.length; i++) n += piece.charCodeAt(i);
  return n;
}

function rebound(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    n += s.charCodeAt(i);
    if (i === 2) s = s.toUpperCase();
  }
  return n;
}

const samples = [
  "the quick brown fox jumps over the lazy dog",
  "",
  " ",
  "abc123 def",
  "café au lait",
  "日本語のテキスト と 空白",
  "emoji 😀 and 🎉 here",
  "lone \uD800 surrogate \uDFFF end",
  "zigzag azbycxdw",
];
for (const s of samples) {
  console.log(
    JSON.stringify(s),
    spaces(s),
    hash(s),
    rises(s),
    peaks(s),
    firstDigit(s),
    pastEnd(s),
    stepped(s),
    rebound(s),
    slicedScan(s, 2, 9),
  );
}

let built = "";
for (let k = 0; k < 40; k++) built += String.fromCharCode(65 + (k % 26)) + (k % 3 === 0 ? " " : "");
const sliced = built.slice(5, 30);
console.log("built", spaces(built), hash(built), rises(sliced), peaks(sliced), sameAt(built, sliced));
console.log("pairs", sameAt("hello world", "help, world!"), sameAt("abc", ""), sameAt("é", "e"));

let total = 0;
for (const s of samples) {
  for (let i = 0; i < s.length; i++) total = (total + s.charCodeAt(i) * (i + 1)) | 0;
}
console.log("nested", total);

let text = "module level scan, with commas, and spaces";
let commas = 0;
for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 44) commas++;
text = "rebound after the loop";
console.log("module", commas, text.length, spaces(text));

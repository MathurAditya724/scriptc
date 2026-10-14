// AES-GCM through createCipheriv/createDecipheriv for 128, 192 and 256-bit
// keys: several setAAD calls before the data, chunked updates, every
// authTagLength Node accepts, IVs of 1, 12, 16 and 64 bytes, string output
// encodings, and decryption checks that reject a wrong tag, a tampered
// ciphertext or changed AAD with Node's error. Keys and IVs are fixed
// byte patterns, so every output is deterministic.
import { createCipheriv, createDecipheriv } from "node:crypto";

function pattern(length: number, seed: number): Buffer {
  const out = Buffer.alloc(length);
  for (let i = 0; i < length; i++) out[i] = (i * 13 + seed) & 0xff;
  return out;
}

function describe(error: unknown): string {
  const e = error as Error & { code?: string };
  return `${e.name} ${e.code} ${e.message}`;
}

const plaintext = Buffer.from("The quick brown fox jumps over the lazy dog, twice: once and again.");
for (const bits of [128, 192, 256]) {
  const name = `aes-${bits}-gcm` as "aes-128-gcm";
  const key = pattern(bits / 8, bits);
  const iv = pattern(12, 1);
  const cipher = createCipheriv(name, key, iv);
  cipher.setAAD(Buffer.from("header-"));
  cipher.setAAD(Buffer.from("part-two"));
  const parts = [cipher.update(plaintext.subarray(0, 5)), cipher.update(plaintext.subarray(5, 40))];
  parts.push(cipher.update(plaintext.subarray(40)), cipher.final());
  const ciphertext = Buffer.concat(parts);
  const tag = cipher.getAuthTag();
  console.log(name, parts.map((p) => p.length).join(","), ciphertext.toString("hex"), tag.toString("hex"));

  const decipher = createDecipheriv(name, key, iv);
  decipher.setAAD(Buffer.from("header-part-two"));
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  console.log("round trip", decrypted.equals(plaintext));

  for (const [label, change] of [
    ["wrong tag", "tag"],
    ["tampered ciphertext", "data"],
    ["changed aad", "aad"],
  ] as const) {
    const check = createDecipheriv(name, key, iv);
    check.setAAD(Buffer.from(change === "aad" ? "header-part-2" : "header-part-two"));
    const badTag = Buffer.from(tag);
    if (change === "tag") badTag[0] ^= 1;
    check.setAuthTag(badTag);
    const data = Buffer.from(ciphertext);
    if (change === "data") data[3] ^= 0x80;
    const partial = check.update(data);
    try {
      check.final();
      console.log(label, "accepted");
    } catch (error) {
      console.log(label, partial.length, describe(error));
    }
  }
}

const key = pattern(16, 9);
for (const length of [4, 8, 12, 13, 14, 15, 16]) {
  const cipher = createCipheriv("aes-128-gcm", key, pattern(12, 2), { authTagLength: length });
  const out = cipher.update("tag length", "utf8", "hex") + cipher.final("hex");
  const tag = cipher.getAuthTag();
  const decipher = createDecipheriv("aes-128-gcm", key, pattern(12, 2), { authTagLength: length });
  decipher.setAuthTag(tag);
  const back = decipher.update(out, "hex", "utf8") + decipher.final("utf8");
  console.log("authTagLength", length, out, tag.toString("hex"), back);
}

for (const ivLength of [1, 12, 16, 64]) {
  const cipher = createCipheriv("aes-256-gcm", pattern(32, 4), pattern(ivLength, 6));
  const out = cipher.update("iv length", "utf8", "base64") + cipher.final("base64");
  console.log("iv", ivLength, out, cipher.getAuthTag().toString("base64"));
}

const empty = createCipheriv("aes-128-gcm", key, pattern(12, 3));
console.log("empty", empty.final().length, empty.getAuthTag().toString("hex"));
const aadOnly = createCipheriv("aes-128-gcm", key, pattern(12, 3));
aadOnly.setAAD(pattern(40, 8));
console.log("aad only", aadOnly.final().length, aadOnly.getAuthTag().toString("hex"));
const latin = createCipheriv("aes-192-gcm", pattern(24, 5), pattern(12, 5));
const latinOut = latin.update("café", "latin1", "latin1") + latin.final("latin1");
console.log("latin1", Buffer.from(latinOut, "latin1").toString("hex"), latin.getAuthTag().toString("hex"));

for (const length of [0, 3, 17]) {
  try {
    createCipheriv("aes-128-gcm", key, pattern(12, 1), { authTagLength: length });
    console.log("authTagLength", length, "accepted");
  } catch (error) {
    console.log("authTagLength", length, describe(error));
  }
}
const mismatch = createDecipheriv("aes-128-gcm", key, pattern(12, 1), { authTagLength: 12 });
try {
  mismatch.setAuthTag(Buffer.alloc(16));
} catch (error) {
  console.log("setAuthTag", describe(error));
}
const noTag = createDecipheriv("aes-128-gcm", key, pattern(12, 1));
noTag.update(Buffer.alloc(4));
try {
  noTag.final();
} catch (error) {
  console.log("no tag", describe(error));
}

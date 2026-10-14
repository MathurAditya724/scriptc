// chacha20-poly1305: encryption and decryption with AAD, the default
// 16-byte tag and every authTagLength from 1 to 16 (a truncated tag is the
// leading bytes of the full tag), AAD added after data (accepted, as in
// OpenSSL), rejection of a wrong tag and of tag lengths that differ from
// authTagLength, and Node's errors for IVs other than 12 bytes and tag
// lengths outside 1 to 16.
import { createCipheriv, createDecipheriv } from "node:crypto";

function pattern(length: number, seed: number): Buffer {
  const out = Buffer.alloc(length);
  for (let i = 0; i < length; i++) out[i] = (i * 11 + seed) & 0xff;
  return out;
}

function describe(error: unknown): string {
  const e = error as Error & { code?: string };
  return `${e.name} ${e.code} ${e.message}`;
}

const key = pattern(32, 1);
const iv = pattern(12, 2);
const plaintext = "chacha20-poly1305 authenticated encryption, with associated data";
const cipher = createCipheriv("chacha20-poly1305", key, iv);
cipher.setAAD(Buffer.from("aad-1"));
cipher.setAAD(Buffer.from("aad-2"));
const ciphertext = cipher.update(plaintext, "utf8", "hex") + cipher.final("hex");
const tag = cipher.getAuthTag();
console.log(ciphertext, tag.toString("hex"));
const decipher = createDecipheriv("chacha20-poly1305", key, iv);
decipher.setAAD(Buffer.from("aad-1aad-2"));
decipher.setAuthTag(tag);
console.log(decipher.update(ciphertext, "hex", "utf8") + decipher.final("utf8"));

const tags: string[] = [];
for (let length = 1; length <= 16; length++) {
  const c = createCipheriv("chacha20-poly1305", key, iv, { authTagLength: length });
  c.update("short");
  c.final();
  const t = c.getAuthTag();
  tags.push(t.toString("hex"));
  const d = createDecipheriv("chacha20-poly1305", key, iv, { authTagLength: length });
  d.setAuthTag(t);
  const out = d.update(createCipheriv("chacha20-poly1305", key, iv).update("short"));
  d.final();
  console.log("authTagLength", length, t.toString("hex"), out.toString());
}
console.log("prefixes", tags.every((t) => tags[15]!.startsWith(t)));

const wrong = createDecipheriv("chacha20-poly1305", key, iv);
const badTag = Buffer.from(tag);
badTag[15] ^= 0xff;
wrong.setAuthTag(badTag);
wrong.update(Buffer.from(ciphertext, "hex"));
try {
  wrong.final();
} catch (error) {
  console.log("wrong tag", describe(error));
}
const late = createCipheriv("chacha20-poly1305", key, iv);
late.setAAD(Buffer.from("early"));
late.update("data first");
late.setAAD(Buffer.from("late"));
late.update("more data");
late.final();
console.log("aad after data", late.getAuthTag().toString("hex"));
const emptyFirst = createCipheriv("chacha20-poly1305", key, iv);
emptyFirst.update("");
emptyFirst.setAAD(Buffer.from("after empty update"));
emptyFirst.update("x");
emptyFirst.final();
console.log("aad after empty update", emptyFirst.getAuthTag().toString("hex"));
for (const ivLength of [0, 8, 11, 13, 16]) {
  try {
    createCipheriv("chacha20-poly1305", key, pattern(ivLength, 3));
    console.log("iv", ivLength, "accepted");
  } catch (error) {
    console.log("iv", ivLength, describe(error));
  }
}
for (const length of [0, 17, 32]) {
  try {
    createCipheriv("chacha20-poly1305", key, iv, { authTagLength: length });
    console.log("authTagLength", length, "accepted");
  } catch (error) {
    console.log("authTagLength", length, describe(error));
  }
}
try {
  createDecipheriv("chacha20-poly1305", key, iv).setAuthTag(Buffer.alloc(8));
  console.log("setAuthTag default accepted");
} catch (error) {
  console.log("setAuthTag default", describe(error));
}
try {
  createDecipheriv("chacha20-poly1305", key, iv, { authTagLength: 8 }).setAuthTag(Buffer.alloc(16));
  console.log("setAuthTag option accepted");
} catch (error) {
  console.log("setAuthTag option", describe(error));
}
try {
  createCipheriv("chacha20-poly1305", pattern(16, 1), iv);
} catch (error) {
  console.log("key", describe(error));
}

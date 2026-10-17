// AES-CTR counter carries inside and across the native kernels' 8-block
// batches, including the 128-bit wrap from all ones to zero, and AES-GCM
// with IVs other than 12 bytes, whose initial counter comes from GHASH,
// encrypted with chunk sizes that split batches. Outputs are printed as
// SHA-256 prefixes and tags.
import { createCipheriv, createDecipheriv, createHash, type CipherGCM, type DecipherGCM } from "node:crypto";

const digest = (b: Buffer) => createHash("sha256").update(b).digest("hex").slice(0, 24);
const data = Buffer.alloc(3000);
for (let i = 0; i < data.length; i++) data[i] = (i * 13 + 5) & 0xff;

const counters = [
  "fffffffffffffffffffffffffffffff8",
  "ffffffffffffffffffffffffffffffff",
  "0000000000000000fffffffffffffffd",
  "00000000000000fffffffffffffffff0",
  "0123456789abcdef0123456789abcdef",
];
for (const counter of counters) {
  for (const bits of [128, 256]) {
    const key = Buffer.alloc(bits / 8, 3);
    const iv = Buffer.from(counter, "hex");
    const whole = createCipheriv(`aes-${bits}-ctr`, key, iv).update(data);
    const chunked = createCipheriv(`aes-${bits}-ctr`, key, iv);
    const parts: Buffer[] = [];
    for (let at = 0, i = 0; at < data.length; i++) {
      const size = [5, 123, 128, 200, 17][i % 5]!;
      parts.push(chunked.update(data.subarray(at, at + size)));
      at += size;
    }
    const back = createDecipheriv(`aes-${bits}-ctr`, key, iv).update(whole);
    console.log("ctr", bits, counter, digest(whole), Buffer.concat(parts).equals(whole), back.equals(data));
  }
}

for (const ivLength of [1, 7, 13, 16, 32, 64, 100]) {
  const iv = Buffer.alloc(ivLength);
  for (let i = 0; i < ivLength; i++) iv[i] = (i * 41 + ivLength) & 0xff;
  const key = Buffer.alloc(32, ivLength);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.alloc(ivLength, 1));
  const parts: Buffer[] = [];
  for (let at = 0, i = 0; at < data.length; i++) {
    const size = [129, 1, 255, 300][i % 4]!;
    parts.push(cipher.update(data.subarray(at, at + size)));
    at += size;
  }
  parts.push(cipher.final());
  const ciphertext = Buffer.concat(parts);
  const tag = (cipher as CipherGCM).getAuthTag();
  const decipher = createDecipheriv("aes-256-gcm", key, iv) as DecipherGCM;
  decipher.setAAD(Buffer.alloc(ivLength, 1));
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  console.log("gcm iv", ivLength, digest(ciphertext), tag.toString("hex"), plain.equals(data));
}

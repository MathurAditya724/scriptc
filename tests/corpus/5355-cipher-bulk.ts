// Bulk encryption and decryption of 1 MiB with every supported cipher,
// split into update() calls whose sizes cross the 128-byte, 512-byte and
// 1 KiB batch boundaries of the native kernels: the SHA-256 of the
// ciphertext, the authentication tag and the decrypted data match Node.
import { createCipheriv, createDecipheriv, createHash, type CipherGCM, type DecipherGCM } from "node:crypto";

const data = Buffer.alloc(1024 * 1024);
for (let i = 0; i < data.length; i++) data[i] = (i * 167 + (i >> 9)) & 0xff;
const sizes = [1, 127, 128, 129, 511, 512, 513, 1023, 1024, 1025, 4096, 65536, 3];

for (const name of [
  "aes-128-cbc", "aes-192-cbc", "aes-256-cbc",
  "aes-128-ctr", "aes-192-ctr", "aes-256-ctr",
  "aes-128-gcm", "aes-192-gcm", "aes-256-gcm",
  "chacha20-poly1305",
]) {
  const keyLength = name.includes("128") ? 16 : name.includes("192") ? 24 : 32;
  const key = Buffer.alloc(keyLength, keyLength + 1);
  const iv = Buffer.alloc(name.includes("cbc") || name.includes("ctr") ? 16 : 12, 9);
  const aead = name.includes("gcm") || name.includes("chacha");
  const cipher = createCipheriv(name, key, iv);
  if (aead) (cipher as CipherGCM).setAAD(Buffer.from("bulk header"));
  const hash = createHash("sha256");
  const parts: Buffer[] = [];
  let offset = 0;
  for (let i = 0; offset < data.length; i++) {
    const size = Math.min(sizes[i % sizes.length]!, data.length - offset);
    const part = cipher.update(data.subarray(offset, offset + size));
    hash.update(part);
    parts.push(part);
    offset += size;
  }
  const last = cipher.final();
  hash.update(last);
  parts.push(last);
  const tag = aead ? (cipher as CipherGCM).getAuthTag().toString("hex") : "";
  const ciphertext = Buffer.concat(parts);
  const decipher = createDecipheriv(name, key, iv);
  if (aead) {
    (decipher as DecipherGCM).setAAD(Buffer.from("bulk header"));
    (decipher as DecipherGCM).setAuthTag(Buffer.from(tag, "hex"));
  }
  const plain: Buffer[] = [];
  for (let at = 0; at < ciphertext.length; at += 70000) plain.push(decipher.update(ciphertext.subarray(at, at + 70000)));
  plain.push(decipher.final());
  console.log(name, ciphertext.length, hash.digest("hex").slice(0, 32), tag, Buffer.concat(plain).equals(data));
}

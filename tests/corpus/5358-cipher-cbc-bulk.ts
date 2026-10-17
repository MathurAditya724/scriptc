// AES-CBC over large inputs: encryption and decryption of 200 KiB with
// update() sizes that cross the native kernels' 8-block decryption
// batches, with and without automatic padding, checking the bytes each
// update() returns (decryption holds the last block back for padding).
import { createCipheriv, createDecipheriv, createHash } from "node:crypto";

const digest = (b: Buffer): string => createHash("sha256").update(b).digest("hex").slice(0, 24);
const data = Buffer.alloc(200 * 1024);
for (let i = 0; i < data.length; i++) data[i] = (i * 3 + (i >> 8)) & 0xff;
const encryptSizes = [100, 128, 129, 2048, 15];
const decryptSizes = [128, 144, 7, 4096];

for (const bits of [128, 192, 256]) {
  for (const pad of [true, false]) {
    const key = Buffer.alloc(bits / 8, bits & 0xff);
    const iv = Buffer.alloc(16, 0x11);
    const cipher = createCipheriv(`aes-${bits}-cbc`, key, iv).setAutoPadding(pad);
    const lengths: number[] = [];
    const parts: Buffer[] = [];
    for (let at = 0, i = 0; at < data.length; i++) {
      const size = encryptSizes[i % encryptSizes.length]!;
      const part = cipher.update(data.subarray(at, at + size));
      if (i < 6) lengths.push(part.length);
      parts.push(part);
      at += size;
    }
    parts.push(cipher.final());
    const ciphertext = Buffer.concat(parts);
    const decipher = createDecipheriv(`aes-${bits}-cbc`, key, iv).setAutoPadding(pad);
    const backLengths: number[] = [];
    const plain: Buffer[] = [];
    for (let at = 0, i = 0; at < ciphertext.length; i++) {
      const size = decryptSizes[i % decryptSizes.length]!;
      const part = decipher.update(ciphertext.subarray(at, at + size));
      if (i < 6) backLengths.push(part.length);
      plain.push(part);
      at += size;
    }
    plain.push(decipher.final());
    console.log(bits, pad, ciphertext.length, digest(ciphertext), lengths.join(","), backLengths.join(","), Buffer.concat(plain).equals(data));
  }
}

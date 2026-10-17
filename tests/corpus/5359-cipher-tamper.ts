// Authentication failures on large AES-GCM and chacha20-poly1305 inputs:
// a flipped bit in the first byte, inside the bulk region, in the final
// partial block, or in the tag makes final() throw Node's error, while the
// decrypted bytes returned by update() still have the input's length.
import { createCipheriv, createDecipheriv, type CipherGCM, type DecipherGCM } from "node:crypto";

const data = Buffer.alloc(100_003);
for (let i = 0; i < data.length; i++) data[i] = (i * 29 + 1) & 0xff;

for (const name of ["aes-128-gcm", "aes-256-gcm", "chacha20-poly1305"]) {
  const key = Buffer.alloc(name.includes("128") ? 16 : 32, 0x5a);
  const iv = Buffer.alloc(12, 0x0c);
  const cipher = createCipheriv(name, key, iv) as CipherGCM;
  const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
  const tag = cipher.getAuthTag();
  for (const [label, position] of [
    ["none", -1],
    ["first byte", 0],
    ["bulk", 50_000],
    ["final block", data.length - 2],
    ["tag", -2],
  ] as const) {
    const changed = Buffer.from(ciphertext);
    const changedTag = Buffer.from(tag);
    if (position >= 0) changed[position] = changed[position]! ^ 0x10;
    if (position === -2) changedTag[5] = changedTag[5]! ^ 0x01;
    const decipher = createDecipheriv(name, key, iv) as DecipherGCM;
    decipher.setAuthTag(changedTag);
    const plain = decipher.update(changed);
    try {
      decipher.final();
      console.log(name, label, plain.length, "authenticated", plain.equals(data));
    } catch (error) {
      console.log(name, label, plain.length, (error as Error).message);
    }
  }
}

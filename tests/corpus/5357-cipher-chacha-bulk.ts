// chacha20-poly1305 over large inputs: 256 KiB encrypted with update()
// sizes that cross the 64-byte block, 512-byte and 1 KiB batch boundaries,
// AAD before data, empty AAD after data and the refusal of non-empty AAD
// after data, truncated tags, and decryption with a different chunking.
// Outputs are printed as SHA-256 prefixes and tags.
import { createCipheriv, createDecipheriv, createHash } from "node:crypto";

const digest = (b: Buffer): string => createHash("sha256").update(b).digest("hex").slice(0, 24);
const data = Buffer.alloc(256 * 1024);
for (let i = 0; i < data.length; i++) data[i] = (i * 7 + (i >> 11)) & 0xff;
const key = Buffer.alloc(32, 0x42);

interface Run {
  label: string;
  sizes: number[];
  lateAad: boolean;
  tagLength: number;
}
const runs: Run[] = [
  { label: "blocks", sizes: [64, 64, 128], lateAad: false, tagLength: 16 },
  { label: "batches", sizes: [511, 513, 1024, 1025, 1], lateAad: false, tagLength: 16 },
  { label: "late aad", sizes: [3000, 70000], lateAad: true, tagLength: 16 },
  { label: "truncated", sizes: [999, 1001], lateAad: false, tagLength: 7 },
  { label: "single", sizes: [256 * 1024], lateAad: true, tagLength: 12 },
];
for (let run = 0; run < runs.length; run++) {
  const { label, sizes, lateAad, tagLength } = runs[run]!;
  const nonce = Buffer.alloc(12, run + 3);
  const cipher = createCipheriv("chacha20-poly1305", key, nonce, { authTagLength: tagLength });
  cipher.setAAD(Buffer.from("before"));
  const parts: Buffer[] = [];
  let at = 0;
  for (let i = 0; at < data.length; i++) {
    const size = Math.min(sizes[i % sizes.length]!, data.length - at);
    parts.push(cipher.update(data.subarray(at, at + size)));
    at += size;
    if (lateAad && i === 0) {
      cipher.setAAD(Buffer.alloc(0));
      try {
        cipher.setAAD(Buffer.from("after the first chunk"));
      } catch (error) {
        console.log(label, "late aad", (error as Error & { code?: string }).code);
      }
    }
  }
  parts.push(cipher.final());
  const ciphertext = Buffer.concat(parts);
  const tag = cipher.getAuthTag();
  console.log(label, digest(ciphertext), tag.toString("hex"));
  const decipher = createDecipheriv("chacha20-poly1305", key, nonce, { authTagLength: tagLength });
  decipher.setAAD(Buffer.from("before"));
  decipher.setAuthTag(tag);
  const plain: Buffer[] = [];
  for (let p = 0; p < ciphertext.length; p += 4097) plain.push(decipher.update(ciphertext.subarray(p, p + 4097)));
  plain.push(decipher.final());
  console.log(label, "decrypted", Buffer.concat(plain).equals(data));
}

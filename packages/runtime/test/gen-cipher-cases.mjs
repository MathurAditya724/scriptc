// Generates cipher test cases with Node as the oracle.
// Each line: <cipher>\t<seed>\t<iv-hex>\t<aad-length>\t<plaintext-length>\t<sha256(ciphertext)>\t<tag-hex|->
//
//   node gen-cipher-cases.mjs > cipher-cases.txt
//
// Keys, AAD and plaintexts are pattern(length, seed) bytes, which
// test_cipher_kernels.c recomputes, so the file stores only the IV, the lengths,
// a digest of the ciphertext and the authentication tag. Lengths cover
// partial blocks and the 128-byte (AES) and 512-byte (ChaCha20) batch
// boundaries of the SIMD kernels; IVs cover CTR counter carries and GCM
// IVs other than 12 bytes. CBC ciphertexts include Node's PKCS#7 padding.
import { createCipheriv, createHash } from "node:crypto";
import { stdout } from "node:process";

const pattern = (length, seed) =>
  Buffer.from(Array.from({ length }, (_, i) => (i * 31 + seed * 7 + 3) & 0xff));

const ciphers = [
  ["aes-128-cbc", 16],
  ["aes-192-cbc", 24],
  ["aes-256-cbc", 32],
  ["aes-128-ctr", 16],
  ["aes-192-ctr", 24],
  ["aes-256-ctr", 32],
  ["aes-128-gcm", 16],
  ["aes-192-gcm", 24],
  ["aes-256-gcm", 32],
  ["chacha20-poly1305", 32],
];
const lengths = [
  0, 1, 15, 16, 17, 63, 64, 65, 127, 128, 129, 255, 256, 511, 512, 513, 1023, 1024, 1025, 4103,
];
const lines = [];
let seed = 1;

function add(name, keyLength, iv, aadLength, length) {
  const s = seed++;
  const cipher = createCipheriv(name, pattern(keyLength, s), iv);
  const aead = name.endsWith("gcm") || name.startsWith("chacha");
  if (aead && aadLength > 0) cipher.setAAD(pattern(aadLength, s + 1));
  const ciphertext = Buffer.concat([cipher.update(pattern(length, s + 2)), cipher.final()]);
  const tag = aead ? cipher.getAuthTag().toString("hex") : "-";
  const digest = createHash("sha256").update(ciphertext).digest("hex");
  lines.push([name, s, iv.toString("hex"), aadLength, length, digest, tag].join("\t"));
}

for (const [name, keyLength] of ciphers) {
  const ivLength = name.endsWith("cbc") || name.endsWith("ctr") ? 16 : 12;
  const aadLengths = name.endsWith("gcm") || name.startsWith("chacha") ? [0, 1, 16, 33] : [0];
  for (const length of lengths) {
    for (const aadLength of aadLengths)
      add(name, keyLength, pattern(ivLength, seed + 100), aadLength, length);
  }
}
for (const name of ["aes-128-ctr", "aes-256-ctr"]) {
  const keyLength = name.includes("128") ? 16 : 32;
  for (const ivHex of [
    "ffffffffffffffffffffffffffffffff",
    "0000000000000000fffffffffffffffa",
    "00000000000000fffffffffffffffff9",
  ]) {
    for (const length of [16, 100, 129, 300])
      add(name, keyLength, Buffer.from(ivHex, "hex"), 0, length);
  }
}
for (const name of ["aes-128-gcm", "aes-256-gcm"]) {
  const keyLength = name.includes("128") ? 16 : 32;
  for (const ivLength of [1, 8, 13, 16, 60, 64]) {
    for (const length of [0, 33, 200])
      add(name, keyLength, pattern(ivLength, seed + 200), 20, length);
  }
}
stdout.write(lines.join("\n") + "\n");

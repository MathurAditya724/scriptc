// Cipheriv and Decipheriv values held as ordinary JavaScript values: kept
// in objects and arrays, passed to helper functions, chained through the
// methods that return the cipher, called with a receiver from a property
// read, and compared by identity.
import { createCipheriv, createDecipheriv } from "node:crypto";

const key = Buffer.alloc(32, 5);
const nonce = Buffer.alloc(12, 6);

function encrypt(cipher, chunks) {
  let out = Buffer.alloc(0);
  for (const chunk of chunks) out = Buffer.concat([out, cipher.update(chunk)]);
  return Buffer.concat([out, cipher.final()]);
}

const ciphers = {
  gcm: createCipheriv("aes-256-gcm", key, nonce),
  chacha: createCipheriv("chacha20-poly1305", key, nonce),
};
const results = {};
for (const name of Object.keys(ciphers)) {
  const cipher = ciphers[name];
  const chained = cipher.setAAD(Buffer.from(name)).setAutoPadding(true);
  console.log(name, chained === cipher, typeof cipher);
  results[name] = { data: encrypt(cipher, ["one ", "two ", "three"]), tag: cipher.getAuthTag() };
  console.log(name, results[name].data.toString("hex"), results[name].tag.toString("hex"));
}

const list = [
  createDecipheriv("aes-256-gcm", key, nonce).setAAD(Buffer.from("gcm")).setAuthTag(results.gcm.tag),
  createDecipheriv("chacha20-poly1305", key, nonce).setAAD(Buffer.from("chacha")).setAuthTag(results.chacha.tag),
];
const inputs = [results.gcm.data, results.chacha.data];
list.forEach((decipher, i) => {
  console.log("decrypted", i, encrypt(decipher, [inputs[i]]).toString());
});

const holder = { cipher: createCipheriv("aes-128-ctr", Buffer.alloc(16, 1), Buffer.alloc(16, 2)) };
console.log("holder", holder.cipher.update("abc", "utf8", "hex"), holder.cipher.final("hex"));

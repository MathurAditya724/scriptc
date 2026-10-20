// The native WebCrypto surface is HMAC importKey('raw'), sign and verify,
// and the SHA-1/SHA-2 digests, called directly on crypto.subtle. The 'jwk'
// key format and crypto.subtle or its methods taken as values are refused
// by name; the bundled declarations omit the other SubtleCrypto methods
// (node-types/fenced.ts pins their fence under @types/node).
const fromJwk = await crypto.subtle.importKey(
  "jwk",
  { kty: "oct", k: "c2VjcmV0" },
  { name: "HMAC", hash: "SHA-256" },
  false,
  ["sign"],
);
console.log(fromJwk.type);

const subtle = crypto.subtle;
console.log(typeof subtle);

console.log(typeof crypto.subtle.sign);

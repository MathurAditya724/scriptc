// The real jose@6.2.12 HS256 path: SignJWT and jwtVerify from jose's
// public jose/jwt/sign, jose/jwt/verify and jose/errors entry points, over
// crypto.subtle importKey, sign and verify. node_modules/jose vendors the
// dist/webapi files those entry points load and their declarations,
// unmodified (MIT, LICENSE.md), with a package.json that exports only
// those entry points.
import { SignJWT } from "jose/jwt/sign";
import { jwtVerify } from "jose/jwt/verify";
import * as errors from "jose/errors";

const encoder = new TextEncoder();
const secret = encoder.encode("scriptc-jose-hs256-shared-secret");
const now = new Date(1_800_000_000_000);
const iat = 1_799_999_000;

async function sign(claims, alg = "HS256", key = secret) {
  const jwt = new SignJWT(claims);
  jwt.setProtectedHeader({ alg, typ: "JWT" });
  jwt.setIssuedAt(iat);
  jwt.setIssuer("urn:scriptc:issuer");
  jwt.setAudience("urn:scriptc:audience");
  jwt.setSubject("alice");
  return jwt.sign(key);
}

async function verify(label, token, options = {}, key = secret) {
  try {
    const { payload, protectedHeader } = await jwtVerify(token, key, {
      algorithms: ["HS256"],
      currentDate: now,
      ...options,
    });
    console.log(label, "ok", JSON.stringify(protectedHeader), JSON.stringify(payload));
  } catch (e) {
    console.log(label, e.code, e.message, e instanceof errors.JOSEError, e.name, e.claim, e.reason);
  }
}

const token = await sign({ role: "admin", exp: iat + 3600 });
console.log(token);
await verify("valid", token, { issuer: "urn:scriptc:issuer", audience: "urn:scriptc:audience" });
await verify("bytes token", encoder.encode(token));
await verify("wrong secret", token, {}, encoder.encode("another-secret"));
const [header, body, signature] = token.split(".");
const forged = Buffer.from(JSON.stringify({ role: "root", sub: "mallory" })).toString("base64url");
await verify("tampered payload", `${header}.${forged}.${signature}`);
await verify("tampered signature", `${header}.${body}.${signature.slice(0, -2)}AA`);
await verify("malformed", "not-a-jwt");
await verify("bad signature encoding", `${header}.${body}.***`);
await verify("expired", token, { currentDate: new Date((iat + 7200) * 1000) });
await verify("clock tolerance", token, { currentDate: new Date((iat + 3610) * 1000), clockTolerance: 30 });
await verify("not yet valid", await sign({ nbf: iat + 600 }));
await verify("issuer", token, { issuer: "urn:other" });
await verify("audience", token, { audience: "urn:other" });
await verify("required claim", token, { requiredClaims: ["jti"] });
await verify("alg not allowed", token, { algorithms: ["HS512"] });
await verify("max token age", token, { maxTokenAge: 600 });

const hs384 = await sign({ scope: "read" }, "HS384");
await verify("hs384", hs384, { algorithms: ["HS384"] });
const hs512 = await sign({ scope: "write" }, "HS512");
await verify("hs512", hs512, { algorithms: ["HS256", "HS512"] });
await verify("hs512 as hs256 only", hs512);
await verify("none", `${Buffer.from('{"alg":"none"}').toString("base64url")}.${body}.`, { algorithms: ["none"] });

// The same key imported once and reused as a CryptoKey.
const cryptoKey = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
await verify("crypto key", token, {}, cryptoKey);
const signingKey = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-512" }, false, ["sign"]);
await verify("wrong key hash", token, {}, signingKey);

// A string passphrase is decoded with the key's encoding, as in Node:
// createPrivateKey's { encoding } and the encoding option of an encrypted
// export both apply to it.
const c = require("node:crypto");

const { privateKey } = c.generateKeyPairSync("ec", { namedCurve: "P-256" });
const pass = "pässwörd";
const hex = Buffer.from(pass).toString("hex");
const pem = privateKey.export({ format: "pem", type: "pkcs8", cipher: "aes-256-cbc", passphrase: hex, encoding: "hex" });
const der = privateKey.export({ format: "der", type: "pkcs8", cipher: "aes-128-cbc", passphrase: pass });

function attempt(label, options) {
  try {
    const key = c.createPrivateKey(options);
    console.log(label, key.asymmetricKeyType, key.equals(privateKey));
  } catch (e) {
    console.log(label, "throws", e.code);
  }
}

attempt("utf8 passphrase", { key: pem, passphrase: pass });
attempt("hex passphrase, encoding hex", { key: Buffer.from(pem), passphrase: hex, encoding: "hex" });
attempt("base64 passphrase, encoding base64", { key: Buffer.from(pem), passphrase: Buffer.from(pass).toString("base64"), encoding: "base64" });
attempt("latin1 passphrase, encoding latin1", { key: Buffer.from(pem), passphrase: Buffer.from(pass).toString("latin1"), encoding: "latin1" });
attempt("hex passphrase, no encoding", { key: pem, passphrase: hex });
attempt("Buffer passphrase, encoding hex", { key: Buffer.from(pem), passphrase: Buffer.from(pass), encoding: "hex" });
attempt("der, hex passphrase, encoding hex", { key: der, format: "der", type: "pkcs8", passphrase: hex, encoding: "hex" });
attempt("hex key string, encoding hex", { key: Buffer.from(pem).toString("hex"), passphrase: hex, encoding: "hex" });

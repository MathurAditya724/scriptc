/* WebCrypto's HMAC slice: crypto.subtle.importKey (raw HMAC keys),
 * sign, verify and the SHA-1/SHA-2 digests, plus the CryptoKey values
 * importKey answers.
 *
 * This unit is only the WebCrypto layer, modeled on Node 24's
 * lib/internal/crypto/webcrypto.js and mac.js: Web IDL argument
 * conversion, algorithm normalization, the CryptoKey handle, promise
 * wrapping and Node's error shapes. The MACs and digests themselves come
 * from node:crypto's digest core (scr_crypto_hmac_raw and
 * scr_crypto_digest_raw in scr_lib.c), and results settle through the
 * deferred crypto queue that node:crypto's callback forms use, so sign,
 * verify and digest settle on a later loop turn like Node's thread-pool
 * jobs while importKey settles at once.
 *
 * Every argument and validation failure rejects the returned promise.
 * Algorithms Node recognizes but this slice does not implement (RSA,
 * ECDSA, AES, SHA-3, ...) and the 'jwk' key format reject with a coded
 * SC2020 Error instead of silently diverging. The compiler links the unit
 * only into programs that call these methods (the webcrypto feature). */
#include "scr_runtime.h"

#include <math.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* ── algorithm registry ───────────────────────────────────────────────
 * The names Node 24 registers per operation (util.js's
 * kAlgorithmDefinitions with the conditional algorithms its OpenSSL
 * build enables), matched case-insensitively. Only HMAC and the SHA-1/
 * SHA-2 digests are implemented. */
static const char *const scr_wc_import_names[] = {
    "AES-CBC",       "AES-CTR",         "AES-GCM",        "AES-KW",       "AES-OCB",
    "Argon2d",       "Argon2i",         "Argon2id",       "ChaCha20-Poly1305",
    "ECDH",          "ECDSA",           "Ed25519",        "Ed448",        "HKDF",
    "HMAC",          "KMAC128",         "KMAC256",        "ML-DSA-44",    "ML-DSA-65",
    "ML-DSA-87",     "ML-KEM-512",      "ML-KEM-768",     "ML-KEM-1024",  "MLKEM768-P256",
    "MLKEM768-X25519", "MLKEM1024-P384", "PBKDF2",        "RSA-OAEP",     "RSA-PSS",
    "RSASSA-PKCS1-v1_5", "X25519",      "X448",
};
static const char *const scr_wc_sign_names[] = {
    "ECDSA",     "Ed25519",   "Ed448",   "HMAC",    "KMAC128",           "KMAC256",
    "ML-DSA-44", "ML-DSA-65", "ML-DSA-87", "RSA-PSS", "RSASSA-PKCS1-v1_5",
};
static const char *const scr_wc_digest_names[] = {
    "SHA-1",     "SHA-256",   "SHA-384",   "SHA-512",   "SHA3-256",      "SHA3-384",
    "SHA3-512",  "cSHAKE128", "cSHAKE256", "KT128",     "KT256",         "TurboSHAKE128",
    "TurboSHAKE256",
};

#define SCR_WC_COUNT(names) (sizeof(names) / sizeof((names)[0]))

/* The implemented hashes: WebCrypto name and node:crypto digest name. */
static const struct {
  const char *name;
  const char *native;
} scr_wc_hashes[] = {
    {"SHA-1", "sha1"},
    {"SHA-256", "sha256"},
    {"SHA-384", "sha384"},
    {"SHA-512", "sha512"},
};

static bool scr_wc_ascii_ieq(const ScrStr *s, const char *name) {
  size_t n = strlen(name);
  if (s->len != n) return false;
  for (size_t i = 0; i < n; i++) {
    unsigned char a = (unsigned char)s->data[i], b = (unsigned char)name[i];
    if (a >= 'a' && a <= 'z') a = (unsigned char)(a - 32);
    if (b >= 'a' && b <= 'z') b = (unsigned char)(b - 32);
    if (a != b) return false;
  }
  return true;
}

/* The canonical registered spelling of `name`, or NULL. */
static const char *scr_wc_lookup(const char *const *names, size_t count, const ScrStr *name) {
  for (size_t i = 0; i < count; i++)
    if (scr_wc_ascii_ieq(name, names[i])) return names[i];
  return NULL;
}

static const char *scr_wc_native_hash(const char *name) {
  for (size_t i = 0; i < SCR_WC_COUNT(scr_wc_hashes); i++)
    if (strcmp(scr_wc_hashes[i].name, name) == 0) return scr_wc_hashes[i].native;
  return NULL;
}

/* ── errors ────────────────────────────────────────────────────────── */

static const char *const scr_wc_ordinals[] = {"1st", "2nd", "3rd", "4th", "5th"};

static void scr_wc_type_error(const char *code, const char *fmt, ...)
    __attribute__((format(printf, 2, 3)));
static void scr_wc_type_error(const char *code, const char *fmt, ...) {
  char message[512];
  va_list ap;
  va_start(ap, fmt);
  int n = vsnprintf(message, sizeof message, fmt, ap);
  va_end(ap);
  if (n < 0) n = 0;
  if ((size_t)n >= sizeof message) n = (int)sizeof message - 1;
  scr_throw_error_msg_code(SCR_ERR_TYPE, message, (size_t)n, code);
}

/* An operation or algorithm Node supports that this slice does not. */
static void scr_wc_unsupported(const char *method, const char *what) {
  char message[256];
  int n = snprintf(message, sizeof message, "crypto.subtle.%s with %s is not supported yet", method,
                   what);
  if ((size_t)n >= sizeof message) n = (int)sizeof message - 1;
  scr_throw_error_msg_code(SCR_ERR_ERROR, message, (size_t)n, "SC2020");
}

static void scr_wc_unsupported_algorithm(const char *method, const char *name) {
  char what[96];
  snprintf(what, sizeof what, "the %s algorithm", name);
  scr_wc_unsupported(method, what);
}

/* ── Web IDL conversions ──────────────────────────────────────────────
 * Each answers NULL/false with the TypeError pending. `prefix` is
 * "Failed to execute '<method>' on 'SubtleCrypto'". */

static bool scr_wc_is_object(const ScrDyn *v) {
  switch (v->kind) {
  case SCR_DYN_UNDEF:
  case SCR_DYN_NULL:
  case SCR_DYN_BOOL:
  case SCR_DYN_NUM:
  case SCR_DYN_STR:
  case SCR_DYN_BIGINT:
  case SCR_DYN_SYMBOL:
    return false;
  default:
    return true;
  }
}

/* A typed reference capsule as its plain view; other values retained. */
static ScrDyn *scr_wc_plain(ScrDyn *v) {
  if (v->kind == SCR_DYN_TYPED_REF) return scr_dyn_typed_ref_materialize(v);
  return scr_dyn_retain(v);
}

/* BufferSource: the bytes of a TypedArray, DataView, Buffer or
 * ArrayBuffer as a u8 view (+1). */
static ScrBytes *scr_wc_buffer_source(const char *prefix, size_t index, ScrDyn *value) {
  ScrDyn *plain = scr_wc_plain(value);
  if (!plain) return NULL;
  ScrBytes *view = NULL;
  if (plain->kind == SCR_DYN_BYTES || scr_array_buffer_is(plain)) {
    view = scr_bytes_buffer_source(plain);
  } else {
    scr_wc_type_error("ERR_INVALID_ARG_TYPE",
                      "%s: %s argument is not instance of ArrayBuffer, Buffer, TypedArray, or "
                      "DataView.",
                      prefix, scr_wc_ordinals[index]);
  }
  scr_dyn_release(plain);
  return view;
}

/* DOMString conversion (+1). */
static ScrStr *scr_wc_dom_string(const ScrDyn *value) { return scr_dyn_string_coerce_js(value); }

static const char *const scr_wc_key_formats[] = {
    "raw", "raw-public", "raw-seed", "raw-secret", "raw-private", "pkcs8", "spki", "jwk",
};

/* KeyFormat: the canonical enum spelling, or NULL. */
static const char *scr_wc_key_format(const char *prefix, ScrDyn *value) {
  ScrStr *s = scr_wc_dom_string(value);
  if (!s) return NULL;
  for (size_t i = 0; i < SCR_WC_COUNT(scr_wc_key_formats); i++) {
    if (s->len == strlen(scr_wc_key_formats[i]) &&
        memcmp(s->data, scr_wc_key_formats[i], s->len) == 0) {
      scr_str_release(s);
      return scr_wc_key_formats[i];
    }
  }
  scr_wc_type_error("ERR_INVALID_ARG_VALUE",
                    "%s: 1st argument '%.*s' is not a valid enum value of type KeyFormat.", prefix,
                    (int)(s->len > 200 ? 200 : s->len), s->data);
  scr_str_release(s);
  return NULL;
}

/* Node's canonical usage order; the bit is the index. */
static const char *const scr_wc_usages[] = {
    "encrypt",        "decrypt",         "sign",           "verify",
    "deriveKey",      "deriveBits",      "wrapKey",        "unwrapKey",
    "encapsulateKey", "encapsulateBits", "decapsulateKey", "decapsulateBits",
};
enum { SCR_WC_USAGE_SIGN = 1u << 2, SCR_WC_USAGE_VERIFY = 1u << 3 };

/* sequence<KeyUsage> over an array: the usage mask (-1 on failure). */
static long scr_wc_key_usages(const char *prefix, size_t index, ScrDyn *value) {
  ScrDyn *plain = scr_wc_plain(value);
  if (!plain) return -1;
  if (plain->kind != SCR_DYN_ARR) {
    scr_wc_type_error("ERR_INVALID_ARG_TYPE", "%s: %s argument cannot be converted to sequence.",
                      prefix, scr_wc_ordinals[index]);
    scr_dyn_release(plain);
    return -1;
  }
  long mask = 0;
  double n = scr_dyn_arr_len(plain);
  for (double i = 0; i < n; i++) {
    ScrDyn *item = scr_dyn_arr_at(plain, i);
    ScrStr *s = scr_wc_dom_string(item);
    scr_dyn_release(item);
    if (!s) {
      scr_dyn_release(plain);
      return -1;
    }
    size_t k = 0;
    while (k < SCR_WC_COUNT(scr_wc_usages) &&
           !(s->len == strlen(scr_wc_usages[k]) && memcmp(s->data, scr_wc_usages[k], s->len) == 0))
      k++;
    if (k == SCR_WC_COUNT(scr_wc_usages)) {
      scr_wc_type_error("ERR_INVALID_ARG_VALUE",
                        "%s: %s argument[%.0f] '%.*s' is not a valid enum value of type KeyUsage.",
                        prefix, scr_wc_ordinals[index], i, (int)(s->len > 200 ? 200 : s->len),
                        s->data);
      scr_str_release(s);
      scr_dyn_release(plain);
      return -1;
    }
    scr_str_release(s);
    mask |= 1L << k;
  }
  scr_dyn_release(plain);
  return mask;
}

/* ── algorithm normalization ──────────────────────────────────────────
 * normalizeAlgorithm(algorithm, op) for the members this slice reads:
 * the canonical name, and for HMAC imports the hash and length. */
typedef struct {
  const char *name;   /* canonical registered name */
  const char *hash;   /* HMAC import: the normalized hash name */
  bool has_length;
  double length;
} ScrWcAlgorithm;

static const char scr_wc_normalize_prefix[] = "Failed to normalize algorithm";

static void scr_wc_missing_member(const char *dict, const char *member) {
  scr_wc_type_error("ERR_MISSING_OPTION",
                    "%s: passed algorithm cannot be converted to '%s' because '%s' is required in "
                    "'%s'.",
                    scr_wc_normalize_prefix, dict, member, dict);
}

/* Reads `key` off an algorithm dictionary (+1; undefined when absent). */
static ScrDyn *scr_wc_member(const ScrDyn *dict, const char *key) {
  if (dict->kind != SCR_DYN_OBJ) return scr_dyn_retain(scr_dyn_undefined());
  ScrDyn *v = scr_dyn_obj_read(dict, key, strlen(key));
  return v ? v : scr_dyn_retain(scr_dyn_undefined());
}

/* The name an AlgorithmIdentifier carries (+1), with the Algorithm
 * dictionary's missing-name TypeError. `dict` names the dictionary the
 * value converts to. */
static ScrStr *scr_wc_algorithm_name(ScrDyn *identifier, const char *dict) {
  if (!scr_wc_is_object(identifier)) return scr_wc_dom_string(identifier);
  ScrDyn *plain = scr_wc_plain(identifier);
  if (!plain) return NULL;
  ScrDyn *name = scr_wc_member(plain, "name");
  scr_dyn_release(plain);
  ScrStr *out = NULL;
  if (name->kind == SCR_DYN_UNDEF) scr_wc_missing_member(dict, "name");
  else out = scr_wc_dom_string(name);
  scr_dyn_release(name);
  return out;
}

/* The digest a HashAlgorithmIdentifier names: canonical name, or NULL
 * with NotSupportedError / the SC2020 refusal pending. */
static const char *scr_wc_digest_algorithm(ScrDyn *identifier, const char *method) {
  ScrStr *name = scr_wc_algorithm_name(identifier, "Algorithm");
  if (!name) return NULL;
  const char *canonical = scr_wc_lookup(scr_wc_digest_names, SCR_WC_COUNT(scr_wc_digest_names), name);
  scr_str_release(name);
  if (!canonical) {
    scr_throw_domex("NotSupportedError", "Unrecognized algorithm name");
    return NULL;
  }
  if (!scr_wc_native_hash(canonical)) {
    scr_wc_unsupported_algorithm(method, canonical);
    return NULL;
  }
  return canonical;
}

/* HmacImportParams over an object: hash (required, a SHA name), then the
 * optional [EnforceRange] unsigned long length. */
static bool scr_wc_hmac_import_params(ScrDyn *identifier, ScrWcAlgorithm *out) {
  if (!scr_wc_is_object(identifier)) {
    scr_wc_missing_member("HmacImportParams", "hash");
    return false;
  }
  ScrDyn *plain = scr_wc_plain(identifier);
  if (!plain) return false;
  ScrDyn *hash = scr_wc_member(plain, "hash");
  bool ok = true;
  if (hash->kind == SCR_DYN_UNDEF) {
    scr_wc_missing_member("HmacImportParams", "hash");
    ok = false;
  }
  ScrDyn *hash_value = NULL;
  if (ok) {
    /* HashAlgorithmIdentifier converts to an object or a DOMString, then
     * ensureSHA reads the name: a string, or the object's name member. */
    ScrStr *hash_name = NULL;
    if (scr_wc_is_object(hash)) {
      hash_value = scr_dyn_retain(hash);
      ScrDyn *hp = scr_wc_plain(hash);
      ScrDyn *member = hp ? scr_wc_member(hp, "name") : NULL;
      if (hp) scr_dyn_release(hp);
      if (!member) ok = false;
      else {
        if (member->kind == SCR_DYN_STR) hash_name = scr_str_retain(member->v.str);
        scr_dyn_release(member);
      }
    } else {
      hash_name = scr_wc_dom_string(hash);
      if (!hash_name) ok = false;
      else hash_value = scr_dyn_new_str(hash_name);
    }
    bool sha = hash_name && hash_name->len >= 3 &&
               (hash_name->data[0] | 32) == 's' && (hash_name->data[1] | 32) == 'h' &&
               (hash_name->data[2] | 32) == 'a';
    if (hash_name) scr_str_release(hash_name);
    if (ok && !sha) {
      scr_throw_domex("NotSupportedError", "Only SHA hashes are supported in HmacImportParams");
      ok = false;
    }
  }
  if (ok) {
    ScrDyn *length = scr_wc_member(plain, "length");
    if (length->kind != SCR_DYN_UNDEF) {
      double x;
      if (!scr_dyn_number_coerce_js(length, &x)) ok = false;
      else if (x != x || x == 1.0 / 0.0 || x == -1.0 / 0.0) {
        scr_wc_type_error("ERR_INVALID_ARG_TYPE",
                          "%s: length in passed algorithm is not a finite number.",
                          scr_wc_normalize_prefix);
        ok = false;
      } else {
        x = trunc(x);
        if (x == 0) x = 0;
        if (x < 0 || x > 4294967295.0) {
          scr_wc_type_error("ERR_OUT_OF_RANGE",
                            "%s: length in passed algorithm is outside the expected range of 0 to "
                            "4294967295.",
                            scr_wc_normalize_prefix);
          ok = false;
        } else if (x == 0) {
          scr_throw_domex("DataError", "HmacImportParams.length cannot be 0");
          ok = false;
        } else {
          out->has_length = true;
          out->length = x;
        }
      }
    }
    scr_dyn_release(length);
  }
  if (ok) {
    out->hash = scr_wc_digest_algorithm(hash_value, "importKey");
    if (!out->hash) ok = false;
  }
  if (hash_value) scr_dyn_release(hash_value);
  scr_dyn_release(hash);
  scr_dyn_release(plain);
  return ok;
}

/* normalizeAlgorithm for importKey, sign/verify (`names`) — false with
 * the error pending. Only HMAC parameters are read; any other recognized
 * algorithm is refused by the caller. */
static bool scr_wc_normalize(ScrDyn *identifier, const char *const *names, size_t count,
                             bool import, ScrWcAlgorithm *out) {
  memset(out, 0, sizeof *out);
  ScrStr *name = scr_wc_algorithm_name(identifier, "Algorithm");
  if (!name) return false;
  out->name = scr_wc_lookup(names, count, name);
  scr_str_release(name);
  if (!out->name) {
    scr_throw_domex("NotSupportedError", "Unrecognized algorithm name");
    return false;
  }
  if (import && strcmp(out->name, "HMAC") == 0) return scr_wc_hmac_import_params(identifier, out);
  return true;
}

/* ── CryptoKey ─────────────────────────────────────────────────────────
 * A secret HMAC key: the bytes, the hash, the bit length, the usage mask
 * and the extractable flag. The algorithm and usages getters answer the
 * same object on every read (Node caches its clones), built on first
 * read. The bytes are cleared when the last reference goes. */
typedef struct ScrCryptoKey {
  size_t rc;
  const char *hash; /* WebCrypto hash name */
  double length;    /* bits */
  unsigned usages;
  bool extractable;
  ScrDyn *algorithm; /* cached getter results, or NULL */
  ScrDyn *usage_list;
  size_t len;
  unsigned char data[];
} ScrCryptoKey;

static void *scr_crypto_key_retain(void *p) {
  ((ScrCryptoKey *)p)->rc++;
  return p;
}

static void scr_crypto_key_release(void *p) {
  ScrCryptoKey *key = p;
  if (!key || --key->rc != 0) return;
  volatile unsigned char *bytes = key->data;
  for (size_t i = 0; i < key->len; i++) bytes[i] = 0;
  if (key->algorithm) scr_dyn_release(key->algorithm);
  if (key->usage_list) scr_dyn_release(key->usage_list);
  free(key);
}

static ScrCryptoKey *scr_crypto_key_of(const ScrDyn *value) {
  if (value->kind != SCR_DYN_HANDLE || value->v.handle.tag != SCR_DYNH_CRYPTO_KEY) return NULL;
  return value->v.handle.ptr;
}

bool scr_webcrypto_is_crypto_key(const ScrDyn *value) {
  if (value->kind == SCR_DYN_TYPED_REF) return false;
  return scr_crypto_key_of(value) != NULL;
}

static ScrDyn *scr_wc_cstr(const char *s) {
  ScrStr *str = scr_str_new(s, strlen(s));
  ScrDyn *out = scr_dyn_new_str(str);
  scr_str_release(str);
  return out;
}

static ScrDyn *scr_crypto_key_algorithm(ScrCryptoKey *key) {
  if (!key->algorithm) {
    ScrDyn *hash = scr_dyn_new_obj();
    scr_dyn_obj_set(hash, "name", 4, scr_wc_cstr(key->hash));
    ScrDyn *algorithm = scr_dyn_new_obj();
    scr_dyn_obj_set(algorithm, "name", 4, scr_wc_cstr("HMAC"));
    scr_dyn_obj_set(algorithm, "length", 6, scr_dyn_new_num(key->length));
    scr_dyn_obj_set(algorithm, "hash", 4, hash);
    key->algorithm = algorithm;
  }
  return scr_dyn_retain(key->algorithm);
}

static ScrDyn *scr_crypto_key_usages(ScrCryptoKey *key) {
  if (!key->usage_list) {
    ScrDyn *list = scr_dyn_new_arr();
    for (size_t i = 0; i < SCR_WC_COUNT(scr_wc_usages); i++)
      if (key->usages & (1u << i)) scr_dyn_arr_push(list, scr_wc_cstr(scr_wc_usages[i]));
    key->usage_list = list;
  }
  return scr_dyn_retain(key->usage_list);
}

static bool scr_wc_name_is(const char *name, size_t len, const char *literal) {
  return len == strlen(literal) && memcmp(name, literal, len) == 0;
}

static ScrDyn *scr_crypto_key_get(void *h, const char *name, size_t len) {
  ScrCryptoKey *key = h;
  if (scr_wc_name_is(name, len, "type")) return scr_wc_cstr("secret");
  if (scr_wc_name_is(name, len, "extractable")) return scr_dyn_new_bool(key->extractable);
  if (scr_wc_name_is(name, len, "algorithm")) return scr_crypto_key_algorithm(key);
  if (scr_wc_name_is(name, len, "usages")) return scr_crypto_key_usages(key);
  return NULL;
}

/* The four members are prototype getters without setters: an assignment
 * in strict code throws Node's TypeError. */
static bool scr_crypto_key_set(void *h, const char *name, size_t len, const ScrDyn *value) {
  (void)h;
  (void)value;
  if (!scr_wc_name_is(name, len, "type") && !scr_wc_name_is(name, len, "extractable") &&
      !scr_wc_name_is(name, len, "algorithm") && !scr_wc_name_is(name, len, "usages"))
    return false;
  char message[128];
  int n = snprintf(message, sizeof message,
                   "Cannot set property %.*s of #<CryptoKey> which has only a getter", (int)len,
                   name);
  scr_throw_error_msg(SCR_ERR_TYPE, message, (size_t)n);
  return true;
}

static ScrDyn *scr_crypto_key_invoke(void *h, ScrDyn *self, const char *method, ScrDyn *const *args,
                                     size_t argc, const char *what) {
  (void)h;
  (void)self;
  (void)args;
  (void)argc;
  if (strcmp(method, "toString") == 0) return scr_wc_cstr("[object CryptoKey]");
  ScrJsonBuf b;
  scr_jb_init(&b);
  scr_jb_puts(&b, what);
  scr_jb_puts(&b, " is not a function");
  scr_throw_error(SCR_ERR_TYPE, scr_jb_finish(&b));
  return NULL;
}

/* key[Symbol.toStringTag] answers "CryptoKey". */
static ScrDyn *scr_crypto_key_symbol_get(void *h, const ScrDyn *key) {
  (void)h;
  if (key->kind != SCR_DYN_SYMBOL || !key->v.symbol.description) return NULL;
  ScrStr *description = key->v.symbol.description(key->v.symbol.value);
  bool tag = description && description->len == 18 &&
             memcmp(description->data, "Symbol.toStringTag", 18) == 0;
  if (description) scr_str_release(description);
  return tag ? scr_wc_cstr("CryptoKey") : NULL;
}

/* No inspect_view: Node's custom inspector prints the members one level
 * deeper than a plain object would, which the shared handle inspection
 * cannot reproduce, so util.inspect refuses a CryptoKey ('not supported
 * yet') rather than printing a different shape. */
static const ScrDynHandleOps scr_crypto_key_ops = {
    .cls = "CryptoKey",
    .retain = scr_crypto_key_retain,
    .release = scr_crypto_key_release,
    .invoke = scr_crypto_key_invoke,
    .get = scr_crypto_key_get,
    .set = scr_crypto_key_set,
    .json_empty_object = true,
    .to_string_tag = "CryptoKey",
    .symbol_get = scr_crypto_key_symbol_get,
};

static ScrDyn *scr_crypto_key_new(const unsigned char *data, size_t len, const char *hash,
                                  double length, unsigned usages, bool extractable) {
  static SCR_TL bool installed;
  if (!installed) {
    installed = true;
    scr_dyn_handle_install(SCR_DYNH_CRYPTO_KEY, &scr_crypto_key_ops);
  }
  ScrCryptoKey *key = malloc(sizeof *key + (len ? len : 1));
  if (!key) scr_trap("scriptc: out of memory\n");
  key->rc = 1;
  key->hash = hash;
  key->length = length;
  key->usages = usages;
  key->extractable = extractable;
  key->algorithm = NULL;
  key->usage_list = NULL;
  key->len = len;
  if (len) memcpy(key->data, data, len);
  ScrDyn *box = scr_dyn_new_handle(key, SCR_DYNH_CRYPTO_KEY);
  scr_crypto_key_release(key);
  return box;
}

/* ── the operations ───────────────────────────────────────────────────
 * Each takes its argument vector as one dyn array (borrowed) and answers
 * a +1 promise. */

static ScrPromise *scr_wc_rejected(void) {
  ScrPromise *p = scr_promise_new();
  scr_promise_reject_pending(p);
  return p;
}

/* The argument count check every method starts with (after the receiver
 * check the compiler's call shape already guarantees). */
static bool scr_wc_required(const char *prefix, const ScrDyn *args, size_t required) {
  size_t argc = (size_t)scr_dyn_arr_len(args);
  if (argc >= required) return true;
  scr_wc_type_error("ERR_MISSING_ARGS", "%s: %zu arguments required, but only %zu present.", prefix,
                    required, argc);
  return false;
}

typedef struct {
  ScrDyn *v[5];
} ScrWcArgs;

static void scr_wc_args_take(ScrWcArgs *a, const ScrDyn *args, size_t n) {
  for (size_t i = 0; i < n; i++) a->v[i] = scr_dyn_arr_at(args, (double)i);
}

static void scr_wc_args_drop(ScrWcArgs *a, size_t n) {
  for (size_t i = 0; i < n; i++) scr_dyn_release(a->v[i]);
}

/* importKey(format, keyData, algorithm, extractable, keyUsages): Node's
 * conversion order, then macImportKey's checks and importKeySync's empty
 * usage check. */
static ScrDyn *scr_wc_import(const ScrDyn *args) {
  static const char prefix[] = "Failed to execute 'importKey' on 'SubtleCrypto'";
  if (!scr_wc_required(prefix, args, 5)) return NULL;
  ScrWcArgs a;
  scr_wc_args_take(&a, args, 5);
  ScrDyn *result = NULL;
  ScrBytes *data = NULL;
  const char *format = scr_wc_key_format(prefix, a.v[0]);
  if (!format) goto done;
  bool jwk = strcmp(format, "jwk") == 0;
  /* The JsonWebKey dictionary is not implemented; that format is refused
   * after the remaining arguments convert. */
  if (!jwk) {
    data = scr_wc_buffer_source(prefix, 1, a.v[1]);
    if (!data) goto done;
  }
  if (!scr_wc_is_object(a.v[2])) {
    ScrStr *s = scr_wc_dom_string(a.v[2]);
    if (!s) goto done;
    scr_str_release(s);
  }
  bool extractable = scr_dyn_truthy(a.v[3]);
  long usages = scr_wc_key_usages(prefix, 4, a.v[4]);
  if (usages < 0) goto done;
  ScrWcAlgorithm algorithm;
  if (!scr_wc_normalize(a.v[2], scr_wc_import_names, SCR_WC_COUNT(scr_wc_import_names), true,
                        &algorithm))
    goto done;
  if (strcmp(algorithm.name, "HMAC") != 0) {
    scr_wc_unsupported_algorithm("importKey", algorithm.name);
    goto done;
  }
  if (usages & ~(long)(SCR_WC_USAGE_SIGN | SCR_WC_USAGE_VERIFY)) {
    scr_throw_domex("SyntaxError", "Unsupported key usage for HMAC key");
    goto done;
  }
  if (jwk) {
    scr_wc_unsupported("importKey", "the 'jwk' key format");
    goto done;
  }
  if (strcmp(format, "raw") != 0 && strcmp(format, "raw-secret") != 0) {
    char message[96];
    snprintf(message, sizeof message, "Unable to import HMAC using %s format", format);
    scr_throw_domex("NotSupportedError", message);
    goto done;
  }
  {
    ScrBytes *view = data;
    SCR_BYTES_SNAPSHOT(view);
    size_t len = (size_t)scr_bytes_byte_len(view);
    if (len == 0) {
      scr_throw_domex("DataError", "Zero-length key is not supported");
      goto done;
    }
    double length = (double)len * 8;
    unsigned char last = view->data[len - 1];
    if (algorithm.has_length) {
      double bytes = floor(algorithm.length / 8) + floor((7 + fmod(algorithm.length, 8)) / 8);
      if (bytes != (double)len) {
        scr_throw_domex("DataError", "Invalid key length");
        goto done;
      }
      /* A length that is not a whole number of bytes clears the unused
       * low bits of the final byte (truncateToBitLength). */
      int extra = (int)fmod(algorithm.length, 8);
      if (extra) last = (unsigned char)(last & (0xff << (8 - extra)));
      length = algorithm.length;
    }
    if (usages == 0) {
      scr_throw_domex("SyntaxError", "Usages cannot be empty when importing a secret key.");
      goto done;
    }
    result = scr_crypto_key_new(view->data, len, algorithm.hash, length, (unsigned)usages,
                                extractable);
    scr_crypto_key_of(result)->data[len - 1] = last;
  }
done:
  if (data) scr_bytes_release(data);
  scr_wc_args_drop(&a, 5);
  return result;
}

ScrPromise *scr_webcrypto_import_key(ScrDyn *args) {
  ScrDyn *key = scr_wc_import(args);
  if (!key) return scr_wc_rejected();
  return scr_promise_settled_ref(key, &scr_dyn_retain_v, &scr_dyn_release_v, NULL);
}

/* sign(algorithm, key, data) / verify(algorithm, key, signature, data):
 * the HMAC over `data`, or NULL with the error pending. *mac_len is the
 * digest length. */
static bool scr_wc_sign_verify(const ScrDyn *args, bool verify, unsigned char mac[64],
                               size_t *mac_len, ScrBytes **signature) {
  const char *prefix = verify ? "Failed to execute 'verify' on 'SubtleCrypto'"
                              : "Failed to execute 'sign' on 'SubtleCrypto'";
  const char *method = verify ? "verify" : "sign";
  size_t n = verify ? 4 : 3;
  if (!scr_wc_required(prefix, args, n)) return false;
  ScrWcArgs a;
  scr_wc_args_take(&a, args, n);
  bool ok = false;
  ScrBytes *data = NULL;
  if (!scr_wc_is_object(a.v[0])) {
    ScrStr *s = scr_wc_dom_string(a.v[0]);
    if (!s) goto done;
    scr_str_release(s);
  }
  ScrCryptoKey *key = scr_crypto_key_of(a.v[1]);
  if (!key) {
    scr_wc_type_error("ERR_INVALID_ARG_TYPE", "%s: 2nd argument is not of type CryptoKey.", prefix);
    goto done;
  }
  if (verify) {
    *signature = scr_wc_buffer_source(prefix, 2, a.v[2]);
    if (!*signature) goto done;
  }
  data = scr_wc_buffer_source(prefix, verify ? 3 : 2, a.v[verify ? 3 : 2]);
  if (!data) goto done;
  ScrWcAlgorithm algorithm;
  if (!scr_wc_normalize(a.v[0], scr_wc_sign_names, SCR_WC_COUNT(scr_wc_sign_names), false,
                        &algorithm))
    goto done;
  if (strcmp(algorithm.name, "HMAC") != 0) {
    scr_wc_unsupported_algorithm(method, algorithm.name);
    goto done;
  }
  if (!(key->usages & (verify ? SCR_WC_USAGE_VERIFY : SCR_WC_USAGE_SIGN))) {
    char message[64];
    snprintf(message, sizeof message, "Unable to use this key to %s", method);
    scr_throw_domex("InvalidAccessError", message);
    goto done;
  }
  {
    ScrBytes *view = data;
    SCR_BYTES_SNAPSHOT(view);
    *mac_len = scr_crypto_hmac_raw(scr_wc_native_hash(key->hash), key->data, key->len, view->data,
                                   (size_t)scr_bytes_byte_len(view), mac);
  }
  ok = true;
done:
  if (data) scr_bytes_release(data);
  scr_wc_args_drop(&a, n);
  return ok;
}

ScrPromise *scr_webcrypto_sign(ScrDyn *args) {
  unsigned char mac[64];
  size_t mac_len = 0;
  if (!scr_wc_sign_verify(args, false, mac, &mac_len, NULL)) return scr_wc_rejected();
  ScrBytes *out = scr_bytes_new(SCR_BYTES_U8, (double)mac_len);
  memcpy(out->data, mac, mac_len);
  ScrPromise *p = scr_promise_new();
  scr_crypto_defer_bytes(out, NULL, scr_crypto_promise_callback(p),
                         scr_crypto_promise_settle_array_buffer);
  return p;
}

/* The verify result's adapter: the deferred value is a dyn boolean. */
static void scr_wc_settle_verified(ScrClosure *cb, ScrError *error, ScrBytes *value) {
  (void)error;
  ScrPromise *p;
  memcpy(&p, &cb->caps[0]->slot, sizeof p);
  ScrDyn *verified = (ScrDyn *)value;
  scr_promise_fulfill_bool(p, scr_dyn_truthy(verified));
  scr_dyn_release(verified);
}

ScrPromise *scr_webcrypto_verify(ScrDyn *args) {
  unsigned char mac[64];
  size_t mac_len = 0;
  ScrBytes *signature = NULL;
  if (!scr_wc_sign_verify(args, true, mac, &mac_len, &signature)) {
    if (signature) scr_bytes_release(signature);
    return scr_wc_rejected();
  }
  bool equal;
  {
    ScrBytes *view = signature;
    SCR_BYTES_SNAPSHOT(view);
    /* A signature of another length is simply not valid; equal lengths
     * compare in constant time. */
    size_t sig_len = (size_t)scr_bytes_byte_len(view);
    equal = sig_len == mac_len;
    unsigned char diff = 0;
    for (size_t i = 0; equal && i < mac_len; i++) diff |= (unsigned char)(view->data[i] ^ mac[i]);
    equal = equal && diff == 0;
  }
  scr_bytes_release(signature);
  ScrPromise *p = scr_promise_new();
  scr_crypto_defer_dyn(scr_dyn_new_bool(equal), NULL, scr_crypto_promise_callback(p),
                       scr_wc_settle_verified);
  return p;
}

/* digest(algorithm, data). */
ScrPromise *scr_webcrypto_digest(ScrDyn *args) {
  static const char prefix[] = "Failed to execute 'digest' on 'SubtleCrypto'";
  if (!scr_wc_required(prefix, args, 2)) return scr_wc_rejected();
  ScrWcArgs a;
  scr_wc_args_take(&a, args, 2);
  ScrBytes *data = NULL;
  ScrBytes *out = NULL;
  if (!scr_wc_is_object(a.v[0])) {
    ScrStr *s = scr_wc_dom_string(a.v[0]);
    if (!s) goto done;
    scr_str_release(s);
  }
  data = scr_wc_buffer_source(prefix, 1, a.v[1]);
  if (!data) goto done;
  const char *hash = scr_wc_digest_algorithm(a.v[0], "digest");
  if (!hash) goto done;
  {
    ScrBytes *view = data;
    SCR_BYTES_SNAPSHOT(view);
    unsigned char digest[64];
    size_t len = scr_crypto_digest_raw(scr_wc_native_hash(hash), view->data,
                                       (size_t)scr_bytes_byte_len(view), digest);
    out = scr_bytes_new(SCR_BYTES_U8, (double)len);
    memcpy(out->data, digest, len);
  }
done:
  if (data) scr_bytes_release(data);
  scr_wc_args_drop(&a, 2);
  if (!out) return scr_wc_rejected();
  ScrPromise *p = scr_promise_new();
  scr_crypto_defer_bytes(out, NULL, scr_crypto_promise_callback(p),
                         scr_crypto_promise_settle_array_buffer);
  return p;
}

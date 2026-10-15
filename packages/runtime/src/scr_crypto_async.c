/* Callback-style node:crypto wrappers. Kept in a separate executable-only
 * translation unit: library-mode archives and minimal runtime tests link the
 * synchronous digest core without acquiring event-loop or bytes-I/O edges. */
#include "scr_runtime.h"

void scr_crypto_random_bytes_async(double size, ScrClosure *cb, ScrCryptoBytesFn fn) {
  ScrBytes *value = scr_crypto_random_bytes(size);
  if (scr_exc_pending()) {
    scr_closure_release(cb);
    return;
  }
  scr_crypto_defer_bytes(value, NULL, cb, fn);
}

void scr_crypto_pbkdf2_async(ScrBytes *password, ScrBytes *salt,
                             double iterations, double keylen, ScrStr *digest,
                             ScrClosure *cb, ScrCryptoBytesFn fn) {
  const char *failure;
  ScrBytes *value = scr_crypto_pbkdf2_job(password, salt, iterations, keylen, digest, &failure);
  if (scr_exc_pending()) {
    scr_closure_release(cb);
    return;
  }
  if (failure) {
    ScrStr *message = scr_str_new(failure, strlen(failure));
    ScrError *error = scr_error_new(SCR_ERR_ERROR, message);
    scr_str_release(message);
    scr_crypto_defer_bytes(NULL, error, cb, fn);
  } else scr_crypto_defer_bytes(value, NULL, cb, fn);
}

void scr_crypto_hkdf_async(ScrStr *digest, ScrBytes *ikm, ScrBytes *salt,
                           ScrBytes *info, double keylen, ScrClosure *cb, ScrCryptoBytesFn fn) {
  ScrBytes *value = scr_crypto_hkdf_bytes(digest, ikm, salt, info, keylen);
  if (scr_exc_pending()) { scr_closure_release(cb); return; }
  if (value->len == 0) {
    scr_bytes_release(value);
    ScrStr *message = scr_str_new("Deriving bits failed", 20);
    ScrError *error = scr_error_new(SCR_ERR_ERROR, message);
    scr_str_release(message);
    scr_crypto_defer_bytes(NULL, error, cb, fn);
  } else scr_crypto_defer_bytes(value, NULL, cb, fn);
}

void scr_crypto_scrypt_async(ScrBytes *password, ScrBytes *salt, double keylen,
                             ScrDyn *options, ScrClosure *cb, ScrCryptoBytesFn fn) {
  ScrBytes *value = scr_crypto_scrypt(password, salt, keylen, options);
  if (scr_exc_pending()) { scr_closure_release(cb); return; }
  scr_crypto_defer_bytes(value, NULL, cb, fn);
}

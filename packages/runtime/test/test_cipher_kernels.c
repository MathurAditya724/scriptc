/* Checks the mbedTLS cipher path and the scr_cipher_simd.c kernels against
 * Node-generated cases (gen-cipher-cases.mjs). Each case is encrypted in
 * one call on the mbedTLS path and, when the CPU supports the kernels,
 * with several chunkings on the SIMD path; the SIMD path also decrypts
 * the ciphertext back with a different chunking. Prints a summary to
 * stderr and exits nonzero on the first mismatch. */
#include "scr_cipher_simd.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "mbedtls/aes.h"
#include "mbedtls/chachapoly.h"
#include "mbedtls/gcm.h"
#include "mbedtls/sha256.h"

typedef struct {
  char name[32];
  unsigned seed;
  unsigned char iv[64];
  size_t iv_len;
  size_t aad_len;
  size_t pt_len;
  unsigned char digest[32];
  unsigned char tag[16];
  bool has_tag;
} Case;

static void pattern(unsigned char *out, size_t length, unsigned seed) {
  for (size_t i = 0; i < length; i++) out[i] = (unsigned char)((i * 31 + seed * 7 + 3) & 0xff);
}

static size_t unhex(const char *s, unsigned char *out, size_t cap) {
  size_t n = strlen(s) / 2;
  if (n > cap) n = cap;
  for (size_t i = 0; i < n; i++) {
    unsigned v;
    sscanf(s + 2 * i, "%2x", &v);
    out[i] = (unsigned char)v;
  }
  return n;
}

static size_t key_len_of(const char *name) {
  if (strstr(name, "128")) return 16;
  if (strstr(name, "192")) return 24;
  return 32;
}

static bool ends_with(const char *s, const char *suffix) {
  size_t a = strlen(s), b = strlen(suffix);
  return a >= b && strcmp(s + a - b, suffix) == 0;
}

static int failures = 0;

static void check(const Case *c, const char *path, const unsigned char *ct, size_t ct_len, const unsigned char *tag) {
  unsigned char digest[32];
  mbedtls_sha256(ct, ct_len, digest, 0);
  bool ok = memcmp(digest, c->digest, 32) == 0 && (!c->has_tag || memcmp(tag, c->tag, 16) == 0);
  if (!ok && failures++ < 10)
    fprintf(stderr, "mismatch: %s seed=%u aad=%zu len=%zu iv=%zu path=%s\n", c->name, c->seed, c->aad_len,
            c->pt_len, c->iv_len, path);
}

/* The PKCS#7-padded plaintext length for CBC. */
static size_t padded(size_t length) {
  return length + 16 - length % 16;
}

static void run_portable(const Case *c, const unsigned char *key, const unsigned char *aad,
                         const unsigned char *pt, unsigned char *ct) {
  size_t key_len = key_len_of(c->name);
  unsigned char tag[16] = {0};
  if (ends_with(c->name, "cbc")) {
    size_t n = padded(c->pt_len);
    unsigned char *in = malloc(n);
    memcpy(in, pt, c->pt_len);
    memset(in + c->pt_len, (int)(n - c->pt_len), n - c->pt_len);
    mbedtls_aes_context aes;
    mbedtls_aes_init(&aes);
    mbedtls_aes_setkey_enc(&aes, key, (unsigned)key_len * 8);
    unsigned char iv[16];
    memcpy(iv, c->iv, 16);
    mbedtls_aes_crypt_cbc(&aes, MBEDTLS_AES_ENCRYPT, n, iv, in, ct);
    mbedtls_aes_free(&aes);
    free(in);
    check(c, "mbedtls", ct, n, tag);
  } else if (ends_with(c->name, "ctr")) {
    mbedtls_aes_context aes;
    mbedtls_aes_init(&aes);
    mbedtls_aes_setkey_enc(&aes, key, (unsigned)key_len * 8);
    unsigned char counter[16], stream[16];
    size_t offset = 0;
    memcpy(counter, c->iv, 16);
    mbedtls_aes_crypt_ctr(&aes, c->pt_len, &offset, counter, stream, pt, ct);
    mbedtls_aes_free(&aes);
    check(c, "mbedtls", ct, c->pt_len, tag);
  } else if (ends_with(c->name, "gcm")) {
    mbedtls_gcm_context gcm;
    mbedtls_gcm_init(&gcm);
    mbedtls_gcm_setkey(&gcm, MBEDTLS_CIPHER_ID_AES, key, (unsigned)key_len * 8);
    mbedtls_gcm_crypt_and_tag(&gcm, MBEDTLS_GCM_ENCRYPT, c->pt_len, c->iv, c->iv_len, aad, c->aad_len, pt, ct, 16, tag);
    mbedtls_gcm_free(&gcm);
    check(c, "mbedtls", ct, c->pt_len, tag);
  } else {
    mbedtls_chachapoly_context chacha;
    mbedtls_chachapoly_init(&chacha);
    mbedtls_chachapoly_setkey(&chacha, key);
    mbedtls_chachapoly_encrypt_and_tag(&chacha, c->pt_len, c->iv, aad, c->aad_len, pt, ct, tag);
    mbedtls_chachapoly_free(&chacha);
    check(c, "mbedtls", ct, c->pt_len, tag);
  }
}

/* RFC 8439 composition over the SIMD ChaCha20 and Poly1305 kernels. */
static void chachapoly(const unsigned char *key, const unsigned char *nonce, const unsigned char *aad,
                       size_t aad_len, const unsigned char *in, unsigned char *out, size_t len, size_t chunk,
                       bool decrypt, unsigned char tag[16]) {
  static const unsigned char zero[16] = {0};
  ScCsChaCha chacha;
  ScCsPoly1305 poly;
  unsigned char poly_key[64] = {0};
  scr_cs_chacha_start(&chacha, key, nonce, 0);
  scr_cs_chacha_xor(&chacha, poly_key, poly_key, sizeof poly_key);
  scr_cs_poly_start(&poly, poly_key);
  scr_cs_poly_update(&poly, aad, aad_len);
  if (aad_len % 16) scr_cs_poly_update(&poly, zero, 16 - aad_len % 16);
  for (size_t at = 0; at < len; at += chunk) {
    size_t n = len - at < chunk ? len - at : chunk;
    if (decrypt) scr_cs_poly_update(&poly, in + at, n);
    scr_cs_chacha_xor(&chacha, in + at, out + at, n);
    if (!decrypt) scr_cs_poly_update(&poly, out + at, n);
  }
  if (len % 16) scr_cs_poly_update(&poly, zero, 16 - len % 16);
  unsigned char lengths[16];
  for (int i = 0; i < 8; i++) {
    lengths[i] = (unsigned char)((unsigned long long)aad_len >> (8 * i));
    lengths[8 + i] = (unsigned char)((unsigned long long)len >> (8 * i));
  }
  scr_cs_poly_update(&poly, lengths, 16);
  scr_cs_poly_finish(&poly, tag);
}

static void gcm_pass(const Case *c, const unsigned char *key, size_t key_len, const unsigned char *aad,
                     const unsigned char *pt, unsigned char *ct, unsigned char *back, size_t chunk, size_t back_chunk,
                     bool narrow, unsigned char tag[16], unsigned char check_tag[16]) {
  ScCsGcm gcm;
  scr_cs_gcm_start(&gcm, key, key_len, c->iv, c->iv_len, false);
  if (narrow) gcm.wide = false;
  for (size_t at = 0; at < c->aad_len; at += 5) scr_cs_gcm_aad(&gcm, aad + at, c->aad_len - at < 5 ? c->aad_len - at : 5);
  for (size_t at = 0; at < c->pt_len; at += chunk) {
    size_t n = c->pt_len - at < chunk ? c->pt_len - at : chunk;
    scr_cs_gcm_update(&gcm, pt + at, ct + at, n);
  }
  scr_cs_gcm_finish(&gcm, tag);
  scr_cs_gcm_start(&gcm, key, key_len, c->iv, c->iv_len, true);
  if (narrow) gcm.wide = false;
  scr_cs_gcm_aad(&gcm, aad, c->aad_len);
  for (size_t at = 0; at < c->pt_len; at += back_chunk) {
    size_t n = c->pt_len - at < back_chunk ? c->pt_len - at : back_chunk;
    scr_cs_gcm_update(&gcm, ct + at, back + at, n);
  }
  scr_cs_gcm_finish(&gcm, check_tag);
  if ((memcmp(back, pt, c->pt_len) != 0 || memcmp(tag, check_tag, 16) != 0) && failures++ < 10)
    fprintf(stderr, "gcm decrypt mismatch seed=%u%s\n", c->seed, narrow ? " (narrow)" : "");
}

static void run_simd(const Case *c, const unsigned char *key, const unsigned char *aad, const unsigned char *pt,
                     unsigned char *ct, unsigned char *back) {
  static const size_t chunks[] = {(size_t)-1, 1, 7, 100, 129, 513};
  size_t key_len = key_len_of(c->name);
  for (size_t k = 0; k < sizeof chunks / sizeof chunks[0]; k++) {
    size_t chunk = chunks[k];
    unsigned char tag[16] = {0}, check_tag[16] = {0};
    char path[32];
    snprintf(path, sizeof path, "simd/%zu", chunk == (size_t)-1 ? (size_t)0 : chunk);
    size_t back_chunk = chunk == 1 ? 333 : 1;
    size_t ct_len = c->pt_len;
    if (ends_with(c->name, "cbc")) {
      size_t n = padded(c->pt_len);
      unsigned char *in = malloc(n);
      memcpy(in, pt, c->pt_len);
      memset(in + c->pt_len, (int)(n - c->pt_len), n - c->pt_len);
      ScCsAesKey enc, dec;
      scr_cs_aes_setkey(&enc, &dec, key, key_len);
      unsigned char iv[16];
      memcpy(iv, c->iv, 16);
      size_t step = chunk == (size_t)-1 ? n : (chunk + 15) / 16 * 16;
      for (size_t at = 0; at < n; at += step) scr_cs_aes_cbc_encrypt(&enc, iv, in + at, ct + at, (n - at < step ? n - at : step) / 16);
      memcpy(iv, c->iv, 16);
      for (size_t at = 0; at < n; at += 16 * back_chunk) {
        size_t m = n - at < 16 * back_chunk ? n - at : 16 * back_chunk;
        scr_cs_aes_cbc_decrypt(&dec, iv, ct + at, back + at, m / 16);
      }
      if (memcmp(back, in, n) != 0 && failures++ < 10) fprintf(stderr, "cbc decrypt mismatch seed=%u\n", c->seed);
      free(in);
      ct_len = n;
    } else if (ends_with(c->name, "ctr")) {
      ScCsAesKey enc;
      scr_cs_aes_setkey(&enc, NULL, key, key_len);
      unsigned char counter[16], stream[16];
      size_t offset = 0;
      memcpy(counter, c->iv, 16);
      for (size_t at = 0; at < c->pt_len; at += chunk) {
        size_t n = c->pt_len - at < chunk ? c->pt_len - at : chunk;
        scr_cs_aes_ctr(&enc, counter, stream, &offset, pt + at, ct + at, n);
      }
      memcpy(counter, c->iv, 16);
      offset = 0;
      for (size_t at = 0; at < c->pt_len; at += back_chunk) {
        size_t n = c->pt_len - at < back_chunk ? c->pt_len - at : back_chunk;
        scr_cs_aes_ctr(&enc, counter, stream, &offset, ct + at, back + at, n);
      }
      if (memcmp(back, pt, c->pt_len) != 0 && failures++ < 10) fprintf(stderr, "ctr decrypt mismatch seed=%u\n", c->seed);
    } else if (ends_with(c->name, "gcm")) {
      /* The narrow pass keeps VAES hosts testing the eight-block loop. */
      gcm_pass(c, key, key_len, aad, pt, ct, back, chunk, back_chunk, true, tag, check_tag);
      char narrow_path[40];
      snprintf(narrow_path, sizeof narrow_path, "simd-narrow/%zu", chunk == (size_t)-1 ? (size_t)0 : chunk);
      check(c, narrow_path, ct, ct_len, tag);
      gcm_pass(c, key, key_len, aad, pt, ct, back, chunk, back_chunk, false, tag, check_tag);
    } else {
      chachapoly(key, c->iv, aad, c->aad_len, pt, ct, c->pt_len, chunk, false, tag);
      chachapoly(key, c->iv, aad, c->aad_len, ct, back, c->pt_len, back_chunk, true, check_tag);
      if ((memcmp(back, pt, c->pt_len) != 0 || memcmp(tag, check_tag, 16) != 0) && failures++ < 10)
        fprintf(stderr, "chacha20-poly1305 decrypt mismatch seed=%u\n", c->seed);
    }
    check(c, path, ct, ct_len, tag);
  }
}

int main(int argc, char **argv) {
  if (argc < 2) return 2;
  FILE *f = fopen(argv[1], "r");
  if (!f) return 2;
  bool aes = scr_cs_aes_available(), chacha = scr_cs_chacha_available();
  char line[512];
  size_t cases = 0, simd_cases = 0;
  while (fgets(line, sizeof line, f)) {
    Case c = {0};
    char iv[160], digest[80], tag[40];
    if (sscanf(line, "%31s %u %159s %zu %zu %79s %39s", c.name, &c.seed, iv, &c.aad_len, &c.pt_len, digest, tag) != 7)
      continue;
    c.iv_len = unhex(iv, c.iv, sizeof c.iv);
    unhex(digest, c.digest, 32);
    c.has_tag = strcmp(tag, "-") != 0;
    if (c.has_tag) unhex(tag, c.tag, 16);
    unsigned char key[32], aad[64];
    unsigned char *pt = malloc(c.pt_len + 1), *ct = malloc(c.pt_len + 32), *back = malloc(c.pt_len + 32);
    pattern(key, key_len_of(c.name), c.seed);
    pattern(aad, c.aad_len, c.seed + 1);
    pattern(pt, c.pt_len, c.seed + 2);
    run_portable(&c, key, aad, pt, ct);
    bool simd = strncmp(c.name, "chacha", 6) == 0 ? chacha : aes;
    if (simd) {
      run_simd(&c, key, aad, pt, ct, back);
      simd_cases++;
    }
    free(pt);
    free(ct);
    free(back);
    cases++;
  }
  fclose(f);
  fprintf(stderr, "cases %zu simd %zu failures %d\n", cases, simd_cases, failures);
  return failures == 0 && cases > 0 ? 0 : 1;
}

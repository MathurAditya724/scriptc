/* Unit tests for the createCipheriv/createDecipheriv runtime
 * (scr_cipher.c), built with ASan + -DSCR_RC_AUDIT by cipher.test.ts. The
 * unit is included directly so a test can move a context next to a
 * backend limit (AES-GCM's 2^36 - 32 byte message limit, the 2^61 byte AAD
 * limit, the end of chacha20-poly1305's ChaCha20 block counter) without
 * processing that much data, then check that the failure returns no output
 * and retires the context: every later update(), final(), setAAD(),
 * setAuthTag() and getAuthTag() throws. */
#include "../src/scr_cipher.c"

#include <stdio.h>
#include <string.h>

static long total = 0, failed = 0;

static void check(bool ok, const char *what) {
  total++;
  if (!ok) {
    failed++;
    fprintf(stderr, "FAIL: %s\n", what);
  }
}

/* GCM's limit on encrypted bytes per message (NIST SP 800-38D). */
static const uint64_t GCM_MAX = 0xFFFFFFFE0ull;

static ScrDyn *str(const char *text) {
  ScrStr *s = scr_str_new(text, strlen(text));
  ScrDyn *d = scr_dyn_new_str(s);
  scr_str_release(s);
  return d;
}

static ScrDyn *buffer(size_t len, unsigned char fill) {
  ScrBytes *b = scr_bytes_new(SCR_BYTES_U8, (double)len);
  b->is_buffer = true;
  memset(b->data, fill, len);
  ScrDyn *d = scr_dyn_new_buffer(b);
  scr_bytes_release(b);
  return d;
}

/* The pending exception's "Name: message" (and code), cleared. */
static bool take_error(const char *want, const char *want_code) {
  if (!scr_exc_pending()) return false;
  ScrCaught *caught = scr_exc_take();
  ScrError *error = caught->payload;
  ScrStr *name = scr_error_default_name(error);
  char text[256];
  snprintf(text, sizeof text, "%.*s: %.*s", (int)name->len, name->data, (int)error->message->len,
           error->message->data);
  scr_str_release(name);
  bool ok = strcmp(text, want) == 0;
  if (!ok) fprintf(stderr, "  got \"%s\" want \"%s\"\n", text, want);
  char code[64] = "(none)";
  if (error->code) snprintf(code, sizeof code, "%.*s", (int)error->code->len, error->code->data);
  if (strcmp(code, want_code ? want_code : "(none)") != 0) {
    fprintf(stderr, "  got code %s want %s\n", code, want_code ? want_code : "(none)");
    ok = false;
  }
  scr_caught_release(caught);
  return ok;
}

static ScrDyn *call(ScrDyn *self, const char *method, ScrDyn *a, ScrDyn *b) {
  ScrDyn *args[2] = {a ? a : scr_dyn_undefined(), b ? b : scr_dyn_undefined()};
  return sc_invoke(self->v.handle.ptr, self, method, args, 2, "test");
}

static ScrDyn *create(bool decrypt, const char *name, size_t key_len, size_t iv_len) {
  ScrDyn *n = str(name), *key = buffer(key_len, 1), *iv = buffer(iv_len, 2);
  ScrDyn *h = scr_crypto_cipher_new(decrypt, n, key, iv, scr_dyn_undefined());
  scr_dyn_release(n);
  scr_dyn_release(key);
  scr_dyn_release(iv);
  return h;
}

static ScCipher *ctx(ScrDyn *h) { return h->v.handle.ptr; }

static const char *const UPDATE_STATE = "Error: Trying to add data in unsupported state";

/* After a failure: every method throws, and no data or tag comes back. */
static void check_retired(ScrDyn *h, bool decrypt, const char *label) {
  char what[128];
  ScrDyn *data = buffer(16, 7), *empty = buffer(0, 0), *tag = buffer(16, 0);
  ScrDyn *r = call(h, "update", data, NULL);
  snprintf(what, sizeof what, "%s: update() throws", label);
  check(!r && take_error(UPDATE_STATE, NULL), what);
  r = call(h, "update", empty, NULL);
  snprintf(what, sizeof what, "%s: empty update() throws", label);
  check(!r && take_error(UPDATE_STATE, NULL), what);
  r = call(h, "setAAD", data, NULL);
  snprintf(what, sizeof what, "%s: setAAD() throws", label);
  check(!r && take_error("Error: Invalid state for operation setAAD", "ERR_CRYPTO_INVALID_STATE"), what);
  if (decrypt) {
    r = call(h, "setAuthTag", tag, NULL);
    snprintf(what, sizeof what, "%s: setAuthTag() throws", label);
    check(!r && take_error("Error: Invalid state for operation setAuthTag", "ERR_CRYPTO_INVALID_STATE"), what);
  }
  r = call(h, "final", NULL, NULL);
  snprintf(what, sizeof what, "%s: final() throws", label);
  check(!r && take_error("Error: Invalid state", "ERR_CRYPTO_INVALID_STATE"), what);
  if (!decrypt) {
    r = call(h, "getAuthTag", NULL, NULL);
    snprintf(what, sizeof what, "%s: getAuthTag() throws", label);
    check(!r && take_error("Error: Invalid state for operation getAuthTag", "ERR_CRYPTO_INVALID_STATE"), what);
  }
  scr_dyn_release(data);
  scr_dyn_release(empty);
  scr_dyn_release(tag);
}

/* An update that crosses the GCM message limit throws Node's update error
 * (as Node 24.22 does for the same input) and returns no output. */
static void test_gcm_message_limit(bool decrypt) {
  const char *label = decrypt ? "gcm decipher limit" : "gcm cipher limit";
  char what[128];
  ScrDyn *h = create(decrypt, "aes-256-gcm", 32, 12);
  check(h != NULL, "create aes-256-gcm");
  if (!h) return;
  if (decrypt) {
    ScrDyn *tag = buffer(16, 0);
    scr_dyn_release(call(h, "setAuthTag", tag, NULL));
    scr_dyn_release(tag);
  }
  /* As if GCM_MAX - 32 bytes had been processed, on either backend. */
  ctx(h)->gcm.MBEDTLS_PRIVATE(len) = GCM_MAX - 32;
  ctx(h)->simd_gcm.text_len = GCM_MAX - 32;
  ctx(h)->simd_gcm.data = true;
  ctx(h)->data_started = true;
  ScrDyn *block = buffer(16, 9);
  ScrDyn *r = call(h, "update", block, NULL);
  snprintf(what, sizeof what, "%s: update up to the limit", label);
  ScrBytes *out = r ? scr_bytes_buffer_source(r) : NULL;
  check(out && out->len == 16, what);
  scr_bytes_release(out);
  scr_dyn_release(r);
  r = call(h, "update", block, NULL);
  snprintf(what, sizeof what, "%s: update at the limit", label);
  check(r != NULL, what);
  scr_dyn_release(r);
  ScrDyn *one = buffer(1, 9);
  r = call(h, "update", one, NULL);
  snprintf(what, sizeof what, "%s: update past the limit throws", label);
  check(!r && take_error(UPDATE_STATE, NULL), what);
  check_retired(h, decrypt, label);
  scr_dyn_release(one);
  scr_dyn_release(block);
  scr_dyn_release(h);
}

/* A setAAD() the backend refuses retires the context as well. */
static void test_gcm_aad_limit(void) {
  ScrDyn *h = create(false, "aes-128-gcm", 16, 12);
  check(h != NULL, "create aes-128-gcm");
  if (!h) return;
  ctx(h)->gcm.MBEDTLS_PRIVATE(add_len) = (1ull << 61) - 8;
  ctx(h)->simd_gcm.aad_len = (1ull << 61) - 8;
  ScrDyn *aad = buffer(16, 3);
  ScrDyn *r = call(h, "setAAD", aad, NULL);
  check(!r && take_error("Error: Invalid state for operation setAAD", "ERR_CRYPTO_INVALID_STATE"),
        "gcm aad limit: setAAD() throws");
  check_retired(h, false, "gcm aad limit");
  scr_dyn_release(aad);
  scr_dyn_release(h);
}

/* Without setAuthTag(), chacha20-poly1305 decryption fails in final(),
 * with or without authTagLength. */
static void test_chacha_without_tag(void) {
  ScrDyn *h = create(true, "chacha20-poly1305", 32, 12);
  check(h != NULL, "create chacha20-poly1305");
  if (!h) return;
  ScrDyn *data = buffer(40, 5);
  scr_dyn_release(call(h, "update", data, NULL));
  ScrDyn *r = call(h, "final", NULL, NULL);
  check(!r && take_error("Error: Unsupported state or unable to authenticate data", NULL),
        "chacha20-poly1305 without a tag: final() throws");
  scr_dyn_release(data);
  scr_dyn_release(h);
}

/* The same contexts still work when they stay inside the limits. */
static void test_gcm_round_trip(void) {
  ScrDyn *e = create(false, "aes-128-gcm", 16, 12);
  ScrDyn *data = buffer(100, 4);
  ScrDyn *ct = call(e, "update", data, NULL);
  scr_dyn_release(call(e, "final", NULL, NULL));
  ScrDyn *tag = call(e, "getAuthTag", NULL, NULL);
  check(ct && tag, "gcm round trip: encrypt");
  ScrDyn *d = create(true, "aes-128-gcm", 16, 12);
  scr_dyn_release(call(d, "setAuthTag", tag, NULL));
  ScrDyn *pt = call(d, "update", ct, NULL);
  ScrDyn *fin = call(d, "final", NULL, NULL);
  check(pt && fin && !scr_exc_pending(), "gcm round trip: decrypt");
  if (pt) {
    ScrBytes *a = scr_bytes_buffer_source(pt), *b = scr_bytes_buffer_source(data);
    check(a->len == b->len && memcmp(a->data, b->data, a->len) == 0, "gcm round trip: plaintext");
    scr_bytes_release(a);
    scr_bytes_release(b);
  }
  scr_dyn_release(fin);
  scr_dyn_release(pt);
  scr_dyn_release(d);
  scr_dyn_release(tag);
  scr_dyn_release(ct);
  scr_dyn_release(data);
  scr_dyn_release(e);
}

/* chacha20-poly1305 with the mbedTLS backend, as on a CPU without the
 * SIMD kernels: the context is set up as scr_crypto_cipher_new() does with
 * create()'s key and nonce. */
static void use_mbedtls_chacha(ScCipher *c) {
  unsigned char key[32], nonce[12], poly_key[64] = {0};
  memset(key, 1, sizeof key);
  memset(nonce, 2, sizeof nonce);
  mbedtls_chacha20_setkey(&c->chacha, key);
  mbedtls_chacha20_starts(&c->chacha, nonce, 0);
  mbedtls_chacha20_update(&c->chacha, sizeof poly_key, poly_key, poly_key);
  mbedtls_poly1305_starts(&c->poly, poly_key);
  c->simd = false;
}

/* Moves the keystream to block `counter`, as if the blocks before it had
 * been used, with no keystream bytes left over, on either backend. */
static void set_chacha_counter(ScCipher *c, uint32_t counter) {
  if (c->simd) {
    c->simd_chacha.state[12] = counter;
    c->simd_chacha.used = 64;
    c->simd_chacha.blocks = (uint64_t)UINT32_MAX + 1 - counter;
  } else {
    c->chacha.MBEDTLS_PRIVATE(state)[12] = counter;
    c->chacha.MBEDTLS_PRIVATE(keystream_bytes_used) = 64;
  }
}

/* One near-wrap run: the first block counter, the update sizes, and
 * which updates the counter limit refuses. */
typedef struct {
  const char *label;
  uint32_t counter;
  size_t sizes[4];
  size_t count;
  bool refused[4];
} ChachaRun;

/* The outputs and tag of one run, kept to compare the two backends. */
typedef struct {
  unsigned char out[4][2048];
  bool ok[4];
  unsigned char tag[16];
  bool tag_ok;
} ChachaResult;

static void run_chacha(const ChachaRun *run, bool decrypt, bool simd, ChachaResult *result) {
  char what[160];
  const char *backend = simd ? "simd" : "mbedtls";
  memset(result, 0, sizeof *result);
  ScrDyn *h = create(decrypt, "chacha20-poly1305", 32, 12);
  ScCipher *c = ctx(h);
  if (!simd) use_mbedtls_chacha(c);
  ScrDyn *aad = buffer(13, 6);
  scr_dyn_release(call(h, "setAAD", aad, NULL));
  scr_dyn_release(aad);
  set_chacha_counter(c, run->counter);
  bool any_refused = false;
  for (size_t i = 0; i < run->count; i++) {
    size_t len = run->sizes[i];
    unsigned char in[2048];
    memset(in, (int)(0x40 + i), len);
    memset(result->out[i], 0xAA, sizeof result->out[i]);
    any_refused |= run->refused[i];
    if (!run->refused[i]) {
      result->ok[i] = sc_chacha_update(c, in, len, result->out[i]);
      snprintf(what, sizeof what, "%s (%s, %s): update %zu of %zu bytes", run->label, backend,
               decrypt ? "decipher" : "cipher", i, len);
      check(result->ok[i], what);
      continue;
    }
    /* The refused update writes nothing and leaves the Poly1305 state,
     * the lengths and the pending AAD padding as they were. */
    ScCipher before = *c;
    result->ok[i] = sc_chacha_update(c, in, len, result->out[i]);
    bool untouched = true;
    for (size_t k = 0; k < sizeof result->out[i]; k++) untouched &= result->out[i][k] == 0xAA;
    bool same = memcmp(&before.simd_poly, &c->simd_poly, sizeof c->simd_poly) == 0 &&
                memcmp(&before.poly, &c->poly, sizeof c->poly) == 0 &&
                memcmp(&before.simd_chacha, &c->simd_chacha, sizeof c->simd_chacha) == 0 &&
                memcmp(&before.chacha, &c->chacha, sizeof c->chacha) == 0 &&
                before.text_len == c->text_len && before.aad_open == c->aad_open;
    snprintf(what, sizeof what, "%s (%s, %s): update %zu of %zu bytes is refused unchanged", run->label,
             backend, decrypt ? "decipher" : "cipher", i, len);
    check(!result->ok[i] && untouched && same, what);
  }
  if (!any_refused) {
    result->tag_ok = sc_chacha_finish(c, result->tag);
    snprintf(what, sizeof what, "%s (%s, %s): the tag after the last block", run->label, backend,
             decrypt ? "decipher" : "cipher");
    check(result->tag_ok, what);
  } else {
    /* Through the method: Node's update error, then a retired context. */
    ScrDyn *one = buffer(1, 9);
    ScrDyn *r = call(h, "update", one, NULL);
    snprintf(what, sizeof what, "%s (%s, %s): update() past the counter throws", run->label, backend,
             decrypt ? "decipher" : "cipher");
    check(!r && take_error(UPDATE_STATE, NULL), what);
    scr_dyn_release(one);
    snprintf(what, sizeof what, "%s (%s, %s)", run->label, backend, decrypt ? "decipher" : "cipher");
    check_retired(h, decrypt, what);
  }
  scr_dyn_release(h);
}

/* Near the end of the 32-bit block counter, through every keystream path
 * of the SIMD kernels (sixteen and eight blocks per step, one block, and
 * the leftover bytes of a partial block): the last valid bytes succeed,
 * the first byte past block 2^32 - 1 is refused, and the SIMD kernels and
 * mbedTLS give the same output, refusals and tags. */
static void test_chacha_counter_limit(void) {
  /* Runs without a refusal end exactly at block 2^32 - 1 and check the
   * tag; the others end with a refused byte. */
  static const ChachaRun runs[] = {
      {"chacha last block", UINT32_MAX, {64}, 1, {false}},
      {"chacha past the last block", UINT32_MAX, {64, 1}, 2, {false, true}},
      {"chacha leftover bytes", UINT32_MAX, {30, 34}, 2, {false, false}},
      {"chacha past the leftover bytes", UINT32_MAX, {30, 34, 1}, 3, {false, false, true}},
      {"chacha partial blocks", UINT32_MAX - 1, {100, 28, 1}, 3, {false, false, true}},
      {"chacha sixteen blocks", UINT32_MAX - 15, {1024}, 1, {false}},
      {"chacha past sixteen blocks", UINT32_MAX - 15, {1024, 1}, 2, {false, true}},
      {"chacha sixteen blocks over the counter", UINT32_MAX - 14, {1024, 960, 1}, 3, {true, false, true}},
      {"chacha eight blocks", UINT32_MAX - 7, {512}, 1, {false}},
      {"chacha past eight blocks", UINT32_MAX - 7, {512, 1}, 2, {false, true}},
      {"chacha eight blocks over the counter", UINT32_MAX - 6, {512, 448, 1}, 3, {true, false, true}},
      {"chacha nine blocks from a leftover", UINT32_MAX - 8, {10, 566, 1}, 3, {false, false, true}},
  };
  bool simd = scr_cs_chacha_available();
  for (size_t r = 0; r < sizeof runs / sizeof runs[0]; r++) {
    for (int decrypt = 0; decrypt < 2; decrypt++) {
      static ChachaResult portable, kernels;
      run_chacha(&runs[r], decrypt, false, &portable);
      if (!simd) continue;
      run_chacha(&runs[r], decrypt, true, &kernels);
      char what[160];
      snprintf(what, sizeof what, "%s (%s): the SIMD kernels match mbedTLS", runs[r].label,
               decrypt ? "decipher" : "cipher");
      check(memcmp(&portable, &kernels, sizeof portable) == 0, what);
    }
  }
}

/* AES-GCM's 32-bit block counter (inc32) wraps modulo 2^32 inside the
 * message limit when J0's counter is high, as it can be for an IV that is
 * not 96 bits. Starting next to the wrap, the SIMD kernels (sixteen, eight
 * and one block per step, and a partial block) give mbedTLS's ciphertext
 * and tag. */
static void gcm_wrap_run(bool simd, unsigned char out[2048], size_t *out_len, unsigned char tag[16]) {
  static const size_t sizes[] = {1024, 512, 16, 7, 300};
  ScrDyn *h = create(false, "aes-256-gcm", 32, 12);
  ScCipher *c = ctx(h);
  uint32_t next = UINT32_MAX - 20; /* the counter of the next keystream block */
  if (simd) {
    c->simd_gcm.counter = next;
  } else {
    unsigned char key[32], iv[12];
    memset(key, 1, sizeof key);
    memset(iv, 2, sizeof iv);
    mbedtls_gcm_setkey(&c->gcm, MBEDTLS_CIPHER_ID_AES, key, 256);
    mbedtls_gcm_starts(&c->gcm, MBEDTLS_GCM_ENCRYPT, iv, sizeof iv);
    c->simd = false;
    /* mbedTLS increments y before each block. */
    uint32_t y = next - 1;
    for (int i = 0; i < 4; i++) c->gcm.MBEDTLS_PRIVATE(y)[12 + i] = (unsigned char)(y >> (24 - 8 * i));
  }
  *out_len = 0;
  for (size_t i = 0; i < sizeof sizes / sizeof sizes[0]; i++) {
    ScrDyn *data = buffer(sizes[i], (unsigned char)(0x30 + i));
    ScrDyn *r = call(h, "update", data, NULL);
    ScrBytes *b = r ? scr_bytes_buffer_source(r) : NULL;
    if (b && *out_len + b->len <= 2048) {
      memcpy(out + *out_len, b->data, b->len);
      *out_len += b->len;
    }
    scr_bytes_release(b);
    scr_dyn_release(r);
    scr_dyn_release(data);
  }
  scr_dyn_release(call(h, "final", NULL, NULL));
  ScrDyn *t = call(h, "getAuthTag", NULL, NULL);
  ScrBytes *tb = t ? scr_bytes_buffer_source(t) : NULL;
  memset(tag, 0, 16);
  if (tb && tb->len == 16) memcpy(tag, tb->data, 16);
  scr_bytes_release(tb);
  scr_dyn_release(t);
  scr_dyn_release(h);
}

static void test_gcm_counter_wrap(void) {
  if (!scr_cs_aes_available()) return;
  static unsigned char a[2048], b[2048];
  unsigned char ta[16], tb[16];
  size_t la = 0, lb = 0;
  gcm_wrap_run(false, a, &la, ta);
  gcm_wrap_run(true, b, &lb, tb);
  check(la == 1859 && lb == la && memcmp(a, b, la) == 0 && memcmp(ta, tb, 16) == 0,
        "gcm counter wrap: the SIMD kernels match mbedTLS");
}

int main(void) {
  test_gcm_message_limit(false);
  test_gcm_message_limit(true);
  test_gcm_aad_limit();
  test_chacha_without_tag();
  test_chacha_counter_limit();
  test_gcm_counter_wrap();
  test_gcm_round_trip();
  fprintf(stderr, "%ld/%ld cases passed\n", total - failed, total);
  return failed == 0 ? 0 : 1;
}

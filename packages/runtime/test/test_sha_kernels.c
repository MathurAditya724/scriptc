/* SHA-1 and SHA-256 block kernels (scr_lib.c), built by
 * sha-kernels.test.ts. The unit is included directly so the test can run
 * the SHA-NI blocks and the portable blocks over the same inputs: known
 * vectors, every length from 0 to 1100 bytes, and 1 MiB, each fed whole
 * and in 1-, 7-, 64- and 100-byte updates. On CPUs without the SHA
 * extensions only the portable blocks run. */
#include "../src/scr_lib.c"

#include <stdio.h>
#include <string.h>

static long total = 0, failed = 0;

static void check(bool ok, const char *what, size_t len, size_t chunk) {
  total++;
  if (!ok) {
    failed++;
    fprintf(stderr, "FAIL: %s length %zu chunk %zu\n", what, len, chunk);
  }
}

static void hex(const unsigned char *d, size_t n, char *out) {
  for (size_t i = 0; i < n; i++) sprintf(out + 2 * i, "%02x", d[i]);
}

static void sha256_of(const unsigned char *data, size_t len, size_t chunk, unsigned char out[32]) {
  ScrSha256Ctx ctx;
  scr_sha256_init(&ctx);
  for (size_t at = 0; at < len;) {
    size_t take = chunk == 0 || chunk > len - at ? len - at : chunk;
    scr_sha256_update(&ctx, data + at, take);
    at += take;
  }
  scr_sha256_final(&ctx, out);
}

static void sha1_of(const unsigned char *data, size_t len, size_t chunk, unsigned char out[32]) {
  ScrSha1Ctx ctx;
  scr_sha1_init(&ctx);
  for (size_t at = 0; at < len;) {
    size_t take = chunk == 0 || chunk > len - at ? len - at : chunk;
    scr_sha1_update(&ctx, data + at, take);
    at += take;
  }
  scr_sha1_final(&ctx, out);
}

static void vectors(const char *path) {
  unsigned char d[32];
  char text[65];
  sha256_of((const unsigned char *)"abc", 3, 0, d);
  hex(d, 32, text);
  check(strcmp(text, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad") == 0, path, 3, 0);
  sha256_of((const unsigned char *)"", 0, 0, d);
  hex(d, 32, text);
  check(strcmp(text, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855") == 0, path, 0, 0);
  sha1_of((const unsigned char *)"abc", 3, 0, d);
  hex(d, 20, text);
  check(strcmp(text, "a9993e364706816aba3e25717850c26c9cd0d89d") == 0, path, 3, 0);
  static unsigned char million[1000000];
  memset(million, 'a', sizeof million);
  sha256_of(million, sizeof million, 0, d);
  hex(d, 32, text);
  check(strcmp(text, "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0") == 0, path, sizeof million, 0);
  sha1_of(million, sizeof million, 0, d);
  hex(d, 20, text);
  check(strcmp(text, "34aa973cd4c4daa4f61eeb2bdbad27316534016f") == 0, path, sizeof million, 0);
}

int main(void) {
  enum { BIG = 1 << 20 };
  unsigned char *data = malloc(BIG);
  uint32_t x = 0x9e3779b9u;
  for (size_t i = 0; i < BIG; i++) {
    x ^= x << 13; x ^= x >> 17; x ^= x << 5;
    data[i] = (unsigned char)x;
  }
  static const size_t chunks[] = {0, 1, 7, 64, 100};
  bool ni = false;
#ifdef SCR_SHA_NI
  ni = scr_sha_ni();
#endif
  vectors("portable-or-ni");
  for (size_t len = 0; len <= 1100 + 1; len++) {
    size_t n = len == 1101 ? BIG : len;
    for (size_t c = 0; c < sizeof chunks / sizeof chunks[0]; c++) {
#ifdef SCR_SHA_NI
      if (!ni) continue;
      unsigned char a[32], b[32];
      scr_sha_ni_state = 1;
      sha256_of(data, n, chunks[c], a);
      scr_sha_ni_state = 2;
      sha256_of(data, n, chunks[c], b);
      check(memcmp(a, b, 32) == 0, "sha256 ni vs portable", n, chunks[c]);
      scr_sha_ni_state = 1;
      sha1_of(data, n, chunks[c], a);
      scr_sha_ni_state = 2;
      sha1_of(data, n, chunks[c], b);
      check(memcmp(a, b, 20) == 0, "sha1 ni vs portable", n, chunks[c]);
#endif
    }
  }
#ifdef SCR_SHA_NI
  if (ni) {
    scr_sha_ni_state = 2;
    vectors("portable");
    scr_sha_ni_state = 1;
    vectors("ni");
  }
#endif
  free(data);
  fprintf(stderr, "sha-ni %s\n", ni ? "available" : "absent");
  fprintf(stderr, "%ld/%ld cases passed\n", total - failed, total);
  return failed != 0;
}

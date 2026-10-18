/* x86-64 cipher kernels (see scr_cipher_simd.h). Each function that uses
 * an instruction-set extension carries a target attribute, so the unit
 * builds with the runtime's ordinary flags and the instructions run only
 * after scr_cs_aes_available() or scr_cs_chacha_available() has checked
 * CPUID. On other architectures both checks report false and the kernels
 * are not called. */
#include "scr_cipher_simd.h"

#include <string.h>

#if defined(__x86_64__) && (defined(__clang__) || defined(__GNUC__)) && defined(__SIZEOF_INT128__)

#include <cpuid.h>
#include <immintrin.h>

#define SC_AES __attribute__((target("aes,pclmul,ssse3,sse4.1")))
#define SC_AVX2 __attribute__((target("avx2")))
/* Clang 18 to 21 require evex512 for 512-bit vectors; clang 22 dropped it. */
#if defined(__clang__) && __clang_major__ >= 18 && __clang_major__ < 22
#define SC_AVX512 __attribute__((target("avx512f,evex512")))
#define SC_IFMA __attribute__((target("avx512f,avx512ifma,evex512")))
#define SC_VAES __attribute__((target("aes,pclmul,avx512f,avx512bw,vaes,vpclmulqdq,evex512")))
#else
#define SC_AVX512 __attribute__((target("avx512f")))
#define SC_IFMA __attribute__((target("avx512f,avx512ifma")))
#define SC_VAES __attribute__((target("aes,pclmul,avx512f,avx512bw,vaes,vpclmulqdq")))
#endif

/* CPUID leaf 1 ECX bits and leaf 7 EBX bit 5 (AVX2). */
static unsigned sc_leaf1_ecx(void) {
  unsigned a, b, c, d;
  return __get_cpuid(1, &a, &b, &c, &d) ? c : 0;
}

bool scr_cs_aes_available(void) {
  unsigned c = sc_leaf1_ecx();
  return (c & (1u << 25)) && (c & (1u << 1)) && (c & (1u << 9)) && (c & (1u << 19));
}

/* Bit 0: AVX2 usable; bit 1: AVX-512F usable; bit 2: AVX-512 IFMA usable;
 * bit 3: AVX-512BW, VAES and VPCLMULQDQ usable. */
static unsigned sc_vector_features(void) {
  unsigned c = sc_leaf1_ecx();
  if (!(c & (1u << 27)) || !(c & (1u << 28))) return 0; /* OSXSAVE, AVX */
  unsigned lo, hi;
  __asm__ volatile("xgetbv" : "=a"(lo), "=d"(hi) : "c"(0));
  (void)hi;
  if ((lo & 6) != 6) return 0; /* XMM and YMM state enabled */
  unsigned a, b, d;
  if (!__get_cpuid_count(7, 0, &a, &b, &c, &d) || !(b & (1u << 5))) return 0;
  /* AVX-512F with opmask, ZMM0-15 upper halves and ZMM16-31 enabled. */
  if (!(b & (1u << 16)) || (lo & 0xe0) != 0xe0) return 1;
  unsigned features = 3;
  if (b & (1u << 21)) features |= 4; /* leaf 7 EBX bit 21: AVX-512 IFMA */
  /* Leaf 7 EBX bit 30: AVX-512BW; ECX bits 9 and 10: VAES, VPCLMULQDQ. */
  if ((b & (1u << 30)) && (c & (1u << 9)) && (c & (1u << 10))) features |= 8;
  return features;
}

bool scr_cs_chacha_available(void) {
  return sc_vector_features() != 0;
}

static uint32_t sc_le32(const uint8_t *p) {
  return (uint32_t)p[0] | (uint32_t)p[1] << 8 | (uint32_t)p[2] << 16 | (uint32_t)p[3] << 24;
}

static void sc_put_le32(uint8_t *p, uint32_t v) {
  p[0] = (uint8_t)v;
  p[1] = (uint8_t)(v >> 8);
  p[2] = (uint8_t)(v >> 16);
  p[3] = (uint8_t)(v >> 24);
}

static uint64_t sc_le64(const uint8_t *p) {
  return (uint64_t)sc_le32(p) | (uint64_t)sc_le32(p + 4) << 32;
}

static void sc_put_le64(uint8_t *p, uint64_t v) {
  sc_put_le32(p, (uint32_t)v);
  sc_put_le32(p + 4, (uint32_t)(v >> 32));
}

static uint64_t sc_be64(const uint8_t *p) {
  uint64_t v = 0;
  for (int i = 0; i < 8; i++) v = v << 8 | p[i];
  return v;
}

static void sc_put_be64(uint8_t *p, uint64_t v) {
  for (int i = 7; i >= 0; i--) {
    p[i] = (uint8_t)v;
    v >>= 8;
  }
}

/* ── AES ──────────────────────────────────────────────────────────────── */

/* SubWord through AESKEYGENASSIST: dword 0 of the result is SubWord of
 * source dword 1. */
SC_AES static uint32_t sc_subword(uint32_t w) {
  __m128i v = _mm_aeskeygenassist_si128(_mm_set_epi32(0, 0, (int)w, 0), 0);
  return (uint32_t)_mm_cvtsi128_si32(v);
}

/* FIPS-197 key expansion over little-endian words. */
SC_AES void scr_cs_aes_setkey(ScCsAesKey *enc, ScCsAesKey *dec, const uint8_t *key, size_t key_len) {
  unsigned nk = (unsigned)(key_len / 4);
  unsigned rounds = nk + 6;
  unsigned total = 4 * (rounds + 1);
  uint32_t w[60];
  for (unsigned i = 0; i < nk; i++) w[i] = sc_le32(key + 4 * i);
  uint32_t rcon = 1;
  for (unsigned i = nk; i < total; i++) {
    uint32_t t = w[i - 1];
    if (i % nk == 0) {
      uint32_t s = sc_subword(t);
      t = ((s >> 8) | (s << 24)) ^ rcon;
      rcon = (rcon << 1) ^ ((rcon & 0x80) ? 0x11b : 0);
    } else if (nk > 6 && i % nk == 4) {
      t = sc_subword(t);
    }
    w[i] = w[i - nk] ^ t;
  }
  for (unsigned i = 0; i < total; i++) sc_put_le32(enc->rk + 4 * i, w[i]);
  enc->rounds = rounds;
  if (dec) {
    dec->rounds = rounds;
    memcpy(dec->rk, enc->rk + 16 * rounds, 16);
    for (unsigned r = 1; r < rounds; r++) {
      __m128i k = _mm_loadu_si128((const __m128i *)(enc->rk + 16 * (rounds - r)));
      _mm_storeu_si128((__m128i *)(dec->rk + 16 * r), _mm_aesimc_si128(k));
    }
    memcpy(dec->rk + 16 * rounds, enc->rk, 16);
  }
  memset(w, 0, sizeof w);
}

#define SC_RK(k, r) _mm_loadu_si128((const __m128i *)((k)->rk + 16 * (r)))

SC_AES static inline __m128i sc_encrypt1(const ScCsAesKey *k, __m128i b) {
  b = _mm_xor_si128(b, SC_RK(k, 0));
  for (unsigned r = 1; r < k->rounds; r++) b = _mm_aesenc_si128(b, SC_RK(k, r));
  return _mm_aesenclast_si128(b, SC_RK(k, k->rounds));
}

SC_AES static inline void sc_encrypt8(const ScCsAesKey *k, __m128i b[8]) {
  __m128i key = SC_RK(k, 0);
  for (int i = 0; i < 8; i++) b[i] = _mm_xor_si128(b[i], key);
  for (unsigned r = 1; r < k->rounds; r++) {
    key = SC_RK(k, r);
    for (int i = 0; i < 8; i++) b[i] = _mm_aesenc_si128(b[i], key);
  }
  key = SC_RK(k, k->rounds);
  for (int i = 0; i < 8; i++) b[i] = _mm_aesenclast_si128(b[i], key);
}

SC_AES static inline void sc_decrypt8(const ScCsAesKey *k, __m128i b[8]) {
  __m128i key = SC_RK(k, 0);
  for (int i = 0; i < 8; i++) b[i] = _mm_xor_si128(b[i], key);
  for (unsigned r = 1; r < k->rounds; r++) {
    key = SC_RK(k, r);
    for (int i = 0; i < 8; i++) b[i] = _mm_aesdec_si128(b[i], key);
  }
  key = SC_RK(k, k->rounds);
  for (int i = 0; i < 8; i++) b[i] = _mm_aesdeclast_si128(b[i], key);
}

SC_AES static inline __m128i sc_decrypt1(const ScCsAesKey *k, __m128i b) {
  b = _mm_xor_si128(b, SC_RK(k, 0));
  for (unsigned r = 1; r < k->rounds; r++) b = _mm_aesdec_si128(b, SC_RK(k, r));
  return _mm_aesdeclast_si128(b, SC_RK(k, k->rounds));
}

/* The counter block hi||lo as big-endian bytes. */
SC_AES static inline __m128i sc_ctr_block(uint64_t hi, uint64_t lo) {
  return _mm_set_epi64x((long long)__builtin_bswap64(lo), (long long)__builtin_bswap64(hi));
}

SC_AES void scr_cs_aes_ctr(const ScCsAesKey *key, uint8_t counter[16], uint8_t stream[16], size_t *offset,
                           const uint8_t *in, uint8_t *out, size_t len) {
  size_t n = *offset;
  while (n != 0 && len > 0) {
    *out++ = *in++ ^ stream[n];
    n = (n + 1) & 15;
    len--;
  }
  uint64_t hi = sc_be64(counter), lo = sc_be64(counter + 8);
  while (len >= 128) {
    __m128i b[8];
    for (int i = 0; i < 8; i++) {
      uint64_t l = lo + (uint64_t)i;
      b[i] = sc_ctr_block(l < lo ? hi + 1 : hi, l);
    }
    sc_encrypt8(key, b);
    for (int i = 0; i < 8; i++) {
      __m128i d = _mm_loadu_si128((const __m128i *)(in + 16 * i));
      _mm_storeu_si128((__m128i *)(out + 16 * i), _mm_xor_si128(d, b[i]));
    }
    uint64_t next = lo + 8;
    if (next < lo) hi++;
    lo = next;
    in += 128;
    out += 128;
    len -= 128;
  }
  while (len >= 16) {
    __m128i b = sc_encrypt1(key, sc_ctr_block(hi, lo));
    _mm_storeu_si128((__m128i *)out, _mm_xor_si128(_mm_loadu_si128((const __m128i *)in), b));
    if (++lo == 0) hi++;
    in += 16;
    out += 16;
    len -= 16;
  }
  if (len > 0) {
    _mm_storeu_si128((__m128i *)stream, sc_encrypt1(key, sc_ctr_block(hi, lo)));
    if (++lo == 0) hi++;
    for (size_t i = 0; i < len; i++) out[i] = in[i] ^ stream[i];
    n = len;
  }
  sc_put_be64(counter, hi);
  sc_put_be64(counter + 8, lo);
  *offset = n;
}

SC_AES void scr_cs_aes_cbc_encrypt(const ScCsAesKey *enc, uint8_t iv[16], const uint8_t *in, uint8_t *out,
                                   size_t blocks) {
  __m128i chain = _mm_loadu_si128((const __m128i *)iv);
  for (size_t i = 0; i < blocks; i++) {
    chain = sc_encrypt1(enc, _mm_xor_si128(chain, _mm_loadu_si128((const __m128i *)(in + 16 * i))));
    _mm_storeu_si128((__m128i *)(out + 16 * i), chain);
  }
  _mm_storeu_si128((__m128i *)iv, chain);
}

SC_AES void scr_cs_aes_cbc_decrypt(const ScCsAesKey *dec, uint8_t iv[16], const uint8_t *in, uint8_t *out,
                                   size_t blocks) {
  __m128i chain = _mm_loadu_si128((const __m128i *)iv);
  while (blocks >= 8) {
    __m128i c[8], p[8];
    for (int i = 0; i < 8; i++) c[i] = p[i] = _mm_loadu_si128((const __m128i *)(in + 16 * i));
    sc_decrypt8(dec, p);
    p[0] = _mm_xor_si128(p[0], chain);
    for (int i = 1; i < 8; i++) p[i] = _mm_xor_si128(p[i], c[i - 1]);
    for (int i = 0; i < 8; i++) _mm_storeu_si128((__m128i *)(out + 16 * i), p[i]);
    chain = c[7];
    in += 128;
    out += 128;
    blocks -= 8;
  }
  for (; blocks > 0; blocks--) {
    __m128i c = _mm_loadu_si128((const __m128i *)in);
    _mm_storeu_si128((__m128i *)out, _mm_xor_si128(sc_decrypt1(dec, c), chain));
    chain = c;
    in += 16;
    out += 16;
  }
  _mm_storeu_si128((__m128i *)iv, chain);
}

/* ── GHASH ────────────────────────────────────────────────────────────── */

/* GHASH works on byte-reflected blocks, as in Intel's "Carry-Less
 * Multiplication and Its Usage for Computing the GCM Mode". */
SC_AES static inline __m128i sc_bswap(__m128i v) {
  return _mm_shuffle_epi8(v, _mm_set_epi8(0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15));
}

/* Accumulates the unreduced 256-bit product a·b into lo/mid/hi. */
SC_AES static inline void sc_clmul_acc(__m128i a, __m128i b, __m128i *lo, __m128i *mid, __m128i *hi) {
  *lo = _mm_xor_si128(*lo, _mm_clmulepi64_si128(a, b, 0x00));
  *hi = _mm_xor_si128(*hi, _mm_clmulepi64_si128(a, b, 0x11));
  *mid = _mm_xor_si128(*mid, _mm_xor_si128(_mm_clmulepi64_si128(a, b, 0x10), _mm_clmulepi64_si128(a, b, 0x01)));
}

/* Shifts the reflected 256-bit product left by one bit and reduces it
 * modulo x^128 + x^7 + x^2 + x + 1. */
SC_AES static inline __m128i sc_gf_reduce(__m128i lo, __m128i mid, __m128i hi) {
  __m128i t3 = _mm_xor_si128(lo, _mm_slli_si128(mid, 8));
  __m128i t6 = _mm_xor_si128(hi, _mm_srli_si128(mid, 8));
  __m128i t7 = _mm_srli_epi32(t3, 31);
  __m128i t8 = _mm_srli_epi32(t6, 31);
  t3 = _mm_slli_epi32(t3, 1);
  t6 = _mm_slli_epi32(t6, 1);
  __m128i t9 = _mm_srli_si128(t7, 12);
  t8 = _mm_slli_si128(t8, 4);
  t7 = _mm_slli_si128(t7, 4);
  t3 = _mm_or_si128(t3, t7);
  t6 = _mm_or_si128(_mm_or_si128(t6, t8), t9);
  t7 = _mm_xor_si128(_mm_xor_si128(_mm_slli_epi32(t3, 31), _mm_slli_epi32(t3, 30)), _mm_slli_epi32(t3, 25));
  t8 = _mm_srli_si128(t7, 4);
  t7 = _mm_slli_si128(t7, 12);
  t3 = _mm_xor_si128(t3, t7);
  __m128i t2 = _mm_xor_si128(_mm_xor_si128(_mm_srli_epi32(t3, 1), _mm_srli_epi32(t3, 2)), _mm_srli_epi32(t3, 7));
  t2 = _mm_xor_si128(t2, t8);
  t3 = _mm_xor_si128(t3, t2);
  return _mm_xor_si128(t6, t3);
}

SC_AES static inline __m128i sc_gf_mul(__m128i a, __m128i b) {
  __m128i lo = _mm_setzero_si128(), mid = lo, hi = lo;
  sc_clmul_acc(a, b, &lo, &mid, &hi);
  return sc_gf_reduce(lo, mid, hi);
}

#define SC_H(g, i) _mm_loadu_si128((const __m128i *)(g)->h[i])

/* Folds whole 16-byte blocks into the accumulator, eight at a time. */
SC_AES static void sc_ghash_blocks(ScCsGcm *g, const uint8_t *p, size_t blocks) {
  __m128i x = _mm_loadu_si128((const __m128i *)g->x);
  while (blocks >= 8) {
    __m128i lo = _mm_setzero_si128(), mid = lo, hi = lo;
    for (int i = 0; i < 8; i++) {
      __m128i b = sc_bswap(_mm_loadu_si128((const __m128i *)(p + 16 * i)));
      if (i == 0) b = _mm_xor_si128(b, x);
      sc_clmul_acc(b, SC_H(g, 7 - i), &lo, &mid, &hi);
    }
    x = sc_gf_reduce(lo, mid, hi);
    p += 128;
    blocks -= 8;
  }
  for (; blocks > 0; blocks--) {
    x = sc_gf_mul(_mm_xor_si128(x, sc_bswap(_mm_loadu_si128((const __m128i *)p))), SC_H(g, 0));
    p += 16;
  }
  _mm_storeu_si128((__m128i *)g->x, x);
}

/* Adds bytes to the GHASH input stream. */
SC_AES static void sc_ghash_absorb(ScCsGcm *g, const uint8_t *p, size_t len) {
  if (g->partial_len > 0) {
    size_t take = 16 - g->partial_len < len ? 16 - g->partial_len : len;
    memcpy(g->partial + g->partial_len, p, take);
    g->partial_len += take;
    p += take;
    len -= take;
    if (g->partial_len < 16) return;
    sc_ghash_blocks(g, g->partial, 1);
    g->partial_len = 0;
  }
  if (len >= 16) {
    sc_ghash_blocks(g, p, len / 16);
    p += len & ~(size_t)15;
    len &= 15;
  }
  if (len > 0) {
    memcpy(g->partial, p, len);
    g->partial_len = len;
  }
}

/* Zero-pads and folds a partial GHASH block. */
SC_AES static void sc_ghash_pad(ScCsGcm *g) {
  if (g->partial_len == 0) return;
  memset(g->partial + g->partial_len, 0, 16 - g->partial_len);
  sc_ghash_blocks(g, g->partial, 1);
  g->partial_len = 0;
}

SC_AES void scr_cs_gcm_start(ScCsGcm *g, const uint8_t *key, size_t key_len, const uint8_t *iv, size_t iv_len,
                             bool decrypt) {
  memset(g, 0, sizeof *g);
  scr_cs_aes_setkey(&g->key, NULL, key, key_len);
  __m128i h = sc_bswap(sc_encrypt1(&g->key, _mm_setzero_si128()));
  __m128i power = h;
  for (int i = 0; i < 16; i++) {
    _mm_storeu_si128((__m128i *)g->h[i], power);
    power = sc_gf_mul(power, h);
  }
  if (iv_len == 12) {
    memcpy(g->j0, iv, 12);
    g->j0[15] = 1;
  } else {
    sc_ghash_absorb(g, iv, iv_len);
    sc_ghash_pad(g);
    uint8_t lengths[16] = {0};
    sc_put_be64(lengths + 8, (uint64_t)iv_len * 8);
    sc_ghash_blocks(g, lengths, 1);
    _mm_storeu_si128((__m128i *)g->j0, sc_bswap(_mm_loadu_si128((const __m128i *)g->x)));
    memset(g->x, 0, 16);
  }
  g->counter = ((uint32_t)g->j0[12] << 24 | (uint32_t)g->j0[13] << 16 | (uint32_t)g->j0[14] << 8 | g->j0[15]) + 1;
  g->stream_off = 16;
  g->decrypt = decrypt;
  g->wide = (sc_vector_features() & 8) != 0;
}

bool scr_cs_gcm_aad(ScCsGcm *g, const uint8_t *aad, size_t len) {
  /* AAD is limited to 2^61 bytes. */
  if (g->aad_len + len < g->aad_len || (g->aad_len + len) >> 61 != 0) return false;
  g->aad_len += len;
  sc_ghash_absorb(g, aad, len);
  return true;
}

SC_AES static inline __m128i sc_gcm_block(const ScCsGcm *g, uint32_t counter) {
  return _mm_insert_epi32(_mm_loadu_si128((const __m128i *)g->j0), (int)__builtin_bswap32(counter), 3);
}

/* Encrypts eight counter blocks while folding eight byte-reflected
 * ciphertext blocks `c` from the previous step, so the AES rounds and the
 * carry-less multiplies run on separate execution ports. Returns the
 * reduced GHASH accumulator; `c[0]` already includes the previous one. */
SC_AES static inline __m128i sc_gcm_encrypt8_ghash(const ScCsGcm *g, __m128i b[8], const __m128i c[8]) {
  const ScCsAesKey *k = &g->key;
  __m128i key = SC_RK(k, 0);
  for (int i = 0; i < 8; i++) b[i] = _mm_xor_si128(b[i], key);
  __m128i lo = _mm_setzero_si128(), mid = lo, hi = lo;
  /* AES-128 has 10 rounds, so rounds 1 to 8 are always aesenc rounds. */
  for (unsigned r = 1; r <= 8; r++) {
    key = SC_RK(k, r);
    for (int i = 0; i < 8; i++) b[i] = _mm_aesenc_si128(b[i], key);
    sc_clmul_acc(c[r - 1], SC_H(g, 8 - r), &lo, &mid, &hi);
  }
  for (unsigned r = 9; r < k->rounds; r++) {
    key = SC_RK(k, r);
    for (int i = 0; i < 8; i++) b[i] = _mm_aesenc_si128(b[i], key);
  }
  key = SC_RK(k, k->rounds);
  for (int i = 0; i < 8; i++) b[i] = _mm_aesenclast_si128(b[i], key);
  return sc_gf_reduce(lo, mid, hi);
}

/* Byte reversal within each 128-bit lane. */
SC_VAES static inline __m512i sc_bswap512(__m512i v) {
  return _mm512_shuffle_epi8(v, _mm512_broadcast_i32x4(_mm_set_epi8(0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
                                                                      13, 14, 15)));
}

SC_VAES static inline void sc_clmul_acc512(__m512i a, __m512i b, __m512i *lo, __m512i *mid, __m512i *hi) {
  *lo = _mm512_xor_si512(*lo, _mm512_clmulepi64_epi128(a, b, 0x00));
  *hi = _mm512_xor_si512(*hi, _mm512_clmulepi64_epi128(a, b, 0x11));
  *mid = _mm512_xor_si512(*mid, _mm512_xor_si512(_mm512_clmulepi64_epi128(a, b, 0x10),
                                                 _mm512_clmulepi64_epi128(a, b, 0x01)));
}

/* XOR of the four 128-bit lanes. */
SC_VAES static inline __m128i sc_fold512(__m512i v) {
  __m256i t = _mm256_xor_si256(_mm512_castsi512_si256(v), _mm512_extracti64x4_epi64(v, 1));
  return _mm_xor_si128(_mm256_castsi256_si128(t), _mm256_extracti128_si256(t, 1));
}

/* `groups` runs of sixteen blocks with VAES and VPCLMULQDQ, four blocks per
 * instruction. As in the eight-block loop, each run's ciphertext is folded
 * into GHASH during the next run's AES rounds. */
SC_VAES static void sc_gcm_vaes(ScCsGcm *g, const uint8_t *in, uint8_t *out, size_t groups) {
  const ScCsAesKey *k = &g->key;
  __m512i rk[15];
  for (unsigned r = 0; r <= k->rounds; r++) rk[r] = _mm512_broadcast_i32x4(SC_RK(k, r));
  /* Vector j holds blocks 4j .. 4j + 3, which take H^(16 - 4j) .. H^(13 - 4j). */
  __m512i hp[4];
  for (int j = 0; j < 4; j++) {
    __m512i v = _mm512_castsi128_si512(SC_H(g, 15 - 4 * j));
    v = _mm512_inserti32x4(v, SC_H(g, 14 - 4 * j), 1);
    v = _mm512_inserti32x4(v, SC_H(g, 13 - 4 * j), 2);
    hp[j] = _mm512_inserti32x4(v, SC_H(g, 12 - 4 * j), 3);
  }
  /* Byte-reversed counter blocks keep the 32-bit counter in dword 0 of each
   * lane, where a 32-bit add gives GCM's inc32. */
  __m512i ctr = _mm512_add_epi32(_mm512_broadcast_i32x4(sc_bswap(sc_gcm_block(g, g->counter))),
                                 _mm512_set_epi32(0, 0, 0, 3, 0, 0, 0, 2, 0, 0, 0, 1, 0, 0, 0, 0));
  const __m512i four = _mm512_set_epi32(0, 0, 0, 4, 0, 0, 0, 4, 0, 0, 0, 4, 0, 0, 0, 4);
  __m128i x = _mm_loadu_si128((const __m128i *)g->x);
  __m512i c[4];
  for (size_t n = 0; n < groups; n++) {
    __m512i b[4];
    for (int j = 0; j < 4; j++) {
      b[j] = _mm512_xor_si512(sc_bswap512(ctr), rk[0]);
      ctr = _mm512_add_epi32(ctr, four);
    }
    __m512i lo = _mm512_setzero_si512(), mid = lo, hi = lo;
    if (n == 0) {
      for (unsigned r = 1; r <= 4; r++)
        for (int j = 0; j < 4; j++) b[j] = _mm512_aesenc_epi128(b[j], rk[r]);
    } else {
      for (unsigned r = 1; r <= 4; r++) {
        for (int j = 0; j < 4; j++) b[j] = _mm512_aesenc_epi128(b[j], rk[r]);
        sc_clmul_acc512(c[r - 1], hp[r - 1], &lo, &mid, &hi);
      }
    }
    for (unsigned r = 5; r < k->rounds; r++)
      for (int j = 0; j < 4; j++) b[j] = _mm512_aesenc_epi128(b[j], rk[r]);
    for (int j = 0; j < 4; j++) b[j] = _mm512_aesenclast_epi128(b[j], rk[k->rounds]);
    if (n > 0) x = sc_gf_reduce(sc_fold512(lo), sc_fold512(mid), sc_fold512(hi));
    for (int j = 0; j < 4; j++) {
      __m512i d = _mm512_loadu_si512((const void *)(in + 64 * j));
      __m512i r = _mm512_xor_si512(d, b[j]);
      _mm512_storeu_si512((void *)(out + 64 * j), r);
      c[j] = sc_bswap512(g->decrypt ? d : r);
    }
    c[0] = _mm512_xor_si512(c[0], _mm512_zextsi128_si512(x));
    in += 256;
    out += 256;
  }
  __m512i lo = _mm512_setzero_si512(), mid = lo, hi = lo;
  for (int j = 0; j < 4; j++) sc_clmul_acc512(c[j], hp[j], &lo, &mid, &hi);
  x = sc_gf_reduce(sc_fold512(lo), sc_fold512(mid), sc_fold512(hi));
  _mm_storeu_si128((__m128i *)g->x, x);
  g->counter += (uint32_t)(16 * groups);
}

SC_AES bool scr_cs_gcm_update(ScCsGcm *g, const uint8_t *in, uint8_t *out, size_t len) {
  if (len == 0) return true;
  /* A message is limited to 2^36 - 32 bytes (NIST SP 800-38D). */
  if (len > SC_GCM_MAX_TEXT || g->text_len > SC_GCM_MAX_TEXT - len) return false;
  if (!g->data) {
    sc_ghash_pad(g);
    g->data = true;
  }
  g->text_len += len;
  /* GHASH reads the ciphertext: the output when encrypting, the input
   * when decrypting. */
  while (g->stream_off < 16 && len > 0) {
    uint8_t c = *in;
    uint8_t p = c ^ g->stream[g->stream_off++];
    *out = p;
    sc_ghash_absorb(g, g->decrypt ? &c : &p, 1);
    in++;
    out++;
    len--;
  }
  if (g->wide && len >= 256) {
    size_t groups = len / 256;
    sc_gcm_vaes(g, in, out, groups);
    in += 256 * groups;
    out += 256 * groups;
    len -= 256 * groups;
  }
  size_t bulk = len & ~(size_t)127;
  if (bulk) {
    /* Each step folds the ciphertext of the step before it; `c` holds
     * the blocks still to fold. */
    __m128i x = _mm_loadu_si128((const __m128i *)g->x);
    uint32_t counter = g->counter;
    __m128i c[8];
    for (size_t done = 0; done < bulk; done += 128) {
      __m128i b[8];
      for (int i = 0; i < 8; i++) b[i] = sc_gcm_block(g, counter + (uint32_t)i);
      counter += 8;
      if (done == 0) {
        sc_encrypt8(&g->key, b);
      } else {
        x = sc_gcm_encrypt8_ghash(g, b, c);
      }
      for (int i = 0; i < 8; i++) {
        __m128i d = _mm_loadu_si128((const __m128i *)(in + done + 16 * i));
        __m128i r = _mm_xor_si128(d, b[i]);
        _mm_storeu_si128((__m128i *)(out + done + 16 * i), r);
        c[i] = sc_bswap(g->decrypt ? d : r);
      }
      c[0] = _mm_xor_si128(c[0], x);
    }
    __m128i lo = _mm_setzero_si128(), mid = lo, hi = lo;
    for (int i = 0; i < 8; i++) sc_clmul_acc(c[i], SC_H(g, 7 - i), &lo, &mid, &hi);
    x = sc_gf_reduce(lo, mid, hi);
    _mm_storeu_si128((__m128i *)g->x, x);
    g->counter = counter;
    in += bulk;
    out += bulk;
    len -= bulk;
  }
  while (len >= 16) {
    __m128i d = _mm_loadu_si128((const __m128i *)in);
    __m128i r = _mm_xor_si128(d, sc_encrypt1(&g->key, sc_gcm_block(g, g->counter++)));
    _mm_storeu_si128((__m128i *)out, r);
    sc_ghash_blocks(g, g->decrypt ? in : out, 1);
    in += 16;
    out += 16;
    len -= 16;
  }
  if (len > 0) {
    _mm_storeu_si128((__m128i *)g->stream, sc_encrypt1(&g->key, sc_gcm_block(g, g->counter++)));
    for (size_t i = 0; i < len; i++) out[i] = in[i] ^ g->stream[i];
    sc_ghash_absorb(g, g->decrypt ? in : out, len);
    g->stream_off = len;
  }
  return true;
}

SC_AES void scr_cs_gcm_finish(ScCsGcm *g, uint8_t tag[16]) {
  sc_ghash_pad(g);
  uint8_t lengths[16];
  sc_put_be64(lengths, g->aad_len * 8);
  sc_put_be64(lengths + 8, g->text_len * 8);
  sc_ghash_blocks(g, lengths, 1);
  __m128i s = sc_bswap(_mm_loadu_si128((const __m128i *)g->x));
  __m128i e = sc_encrypt1(&g->key, _mm_loadu_si128((const __m128i *)g->j0));
  _mm_storeu_si128((__m128i *)tag, _mm_xor_si128(s, e));
}

/* ── Poly1305 ─────────────────────────────────────────────────────────── */

#define SC_M44 0xfffffffffffULL
#define SC_M42 0x3ffffffffffULL

typedef unsigned __int128 sc_u128;

/* Reduces d0..d2 (each below 2^128) to 44/44/42-bit limbs. */
static inline void sc_poly_carry(sc_u128 d0, sc_u128 d1, sc_u128 d2, uint64_t h[3]) {
  uint64_t c = (uint64_t)(d0 >> 44);
  uint64_t h0 = (uint64_t)d0 & SC_M44;
  d1 += c;
  c = (uint64_t)(d1 >> 44);
  uint64_t h1 = (uint64_t)d1 & SC_M44;
  d2 += c;
  c = (uint64_t)(d2 >> 42);
  uint64_t h2 = (uint64_t)d2 & SC_M42;
  h0 += c * 5;
  c = h0 >> 44;
  h0 &= SC_M44;
  h1 += c;
  h[0] = h0;
  h[1] = h1;
  h[2] = h2;
}

/* a · r mod 2^130 - 5 for limbs a and r, accumulated into d. */
static inline void sc_poly_mul_acc(const uint64_t a[3], const uint64_t r[3], sc_u128 d[3]) {
  uint64_t s1 = r[1] * (5 << 2), s2 = r[2] * (5 << 2);
  d[0] += (sc_u128)a[0] * r[0] + (sc_u128)a[1] * s2 + (sc_u128)a[2] * s1;
  d[1] += (sc_u128)a[0] * r[1] + (sc_u128)a[1] * r[0] + (sc_u128)a[2] * s2;
  d[2] += (sc_u128)a[0] * r[2] + (sc_u128)a[1] * r[1] + (sc_u128)a[2] * r[0];
}

static inline void sc_poly_limbs(const uint8_t *m, uint64_t hibit, uint64_t out[3]) {
  uint64_t t0 = sc_le64(m), t1 = sc_le64(m + 8);
  out[0] = t0 & SC_M44;
  out[1] = ((t0 >> 44) | (t1 << 20)) & SC_M44;
  out[2] = ((t1 >> 24) & SC_M42) | hibit;
}

/* Four blocks as h = (h + m1)·r^4 + m2·r^3 + m3·r^2 + m4·r, so the four
 * products are independent. */
static inline void sc_poly_step4(const ScCsPoly1305 *p, uint64_t h[3], const uint8_t *m, uint64_t hibit) {
  uint64_t a[3], b[3], c[3], e[3];
  sc_poly_limbs(m, hibit, a);
  sc_poly_limbs(m + 16, hibit, b);
  sc_poly_limbs(m + 32, hibit, c);
  sc_poly_limbs(m + 48, hibit, e);
  a[0] += h[0];
  a[1] += h[1];
  a[2] += h[2];
  sc_u128 d[3] = {0, 0, 0};
  sc_poly_mul_acc(a, p->r4, d);
  sc_poly_mul_acc(b, p->r3, d);
  sc_poly_mul_acc(c, p->r2, d);
  sc_poly_mul_acc(e, p->r, d);
  sc_poly_carry(d[0], d[1], d[2], h);
}

/* Four blocks per step (sc_poly_step4), then two blocks with r^2 and r; a
 * final odd block uses h = (h + m)·r. */
static void sc_poly_blocks(ScCsPoly1305 *p, const uint8_t *m, size_t len, uint64_t hibit) {
  uint64_t h[3] = {p->h[0], p->h[1], p->h[2]};
  while (len >= 64) {
    sc_poly_step4(p, h, m, hibit);
    m += 64;
    len -= 64;
  }
  while (len >= 32) {
    uint64_t a[3], b[3];
    sc_poly_limbs(m, hibit, a);
    sc_poly_limbs(m + 16, hibit, b);
    a[0] += h[0];
    a[1] += h[1];
    a[2] += h[2];
    sc_u128 d[3] = {0, 0, 0};
    sc_poly_mul_acc(a, p->r2, d);
    sc_poly_mul_acc(b, p->r, d);
    sc_poly_carry(d[0], d[1], d[2], h);
    m += 32;
    len -= 32;
  }
  if (len >= 16) {
    uint64_t a[3];
    sc_poly_limbs(m, hibit, a);
    a[0] += h[0];
    a[1] += h[1];
    a[2] += h[2];
    sc_u128 d[3] = {0, 0, 0};
    sc_poly_mul_acc(a, p->r, d);
    sc_poly_carry(d[0], d[1], d[2], h);
  }
  p->h[0] = h[0];
  p->h[1] = h[1];
  p->h[2] = h[2];
}

/* Eight lanes of 44/44/42-bit limbs in 64-bit elements. */
typedef struct {
  __m512i l0, l1, l2;
} ScPolyVec;

/* a · r per lane with 52-bit multiply-adds: each 88-bit limb product is
 * split into its low and high 52 bits, and the carries move the high parts
 * up one limb (2^52 = 2^44 · 2^8, and 2^130 ≡ 5). Inputs below 2^52. */
SC_IFMA static inline ScPolyVec sc_poly_vmul(ScPolyVec a, ScPolyVec r) {
  const __m512i m44 = _mm512_set1_epi64((long long)SC_M44), m42 = _mm512_set1_epi64((long long)SC_M42);
  /* s = r · 20 as (r << 4) + (r << 2). */
  __m512i s1 = _mm512_add_epi64(_mm512_slli_epi64(r.l1, 4), _mm512_slli_epi64(r.l1, 2));
  __m512i s2 = _mm512_add_epi64(_mm512_slli_epi64(r.l2, 4), _mm512_slli_epi64(r.l2, 2));
  __m512i z = _mm512_setzero_si512();
  __m512i lo0 = _mm512_madd52lo_epu64(_mm512_madd52lo_epu64(_mm512_madd52lo_epu64(z, a.l0, r.l0), a.l1, s2), a.l2, s1);
  __m512i hi0 = _mm512_madd52hi_epu64(_mm512_madd52hi_epu64(_mm512_madd52hi_epu64(z, a.l0, r.l0), a.l1, s2), a.l2, s1);
  __m512i lo1 = _mm512_madd52lo_epu64(_mm512_madd52lo_epu64(_mm512_madd52lo_epu64(z, a.l0, r.l1), a.l1, r.l0), a.l2, s2);
  __m512i hi1 = _mm512_madd52hi_epu64(_mm512_madd52hi_epu64(_mm512_madd52hi_epu64(z, a.l0, r.l1), a.l1, r.l0), a.l2, s2);
  __m512i lo2 = _mm512_madd52lo_epu64(_mm512_madd52lo_epu64(_mm512_madd52lo_epu64(z, a.l0, r.l2), a.l1, r.l1), a.l2, r.l0);
  __m512i hi2 = _mm512_madd52hi_epu64(_mm512_madd52hi_epu64(_mm512_madd52hi_epu64(z, a.l0, r.l2), a.l1, r.l1), a.l2, r.l0);
  ScPolyVec h;
  __m512i c = _mm512_add_epi64(_mm512_srli_epi64(lo0, 44), _mm512_slli_epi64(hi0, 8));
  h.l0 = _mm512_and_si512(lo0, m44);
  __m512i t = _mm512_add_epi64(lo1, c);
  c = _mm512_add_epi64(_mm512_srli_epi64(t, 44), _mm512_slli_epi64(hi1, 8));
  h.l1 = _mm512_and_si512(t, m44);
  t = _mm512_add_epi64(lo2, c);
  c = _mm512_add_epi64(_mm512_srli_epi64(t, 42), _mm512_slli_epi64(hi2, 10));
  h.l2 = _mm512_and_si512(t, m42);
  h.l0 = _mm512_add_epi64(h.l0, _mm512_add_epi64(c, _mm512_slli_epi64(c, 2)));
  c = _mm512_srli_epi64(h.l0, 44);
  h.l0 = _mm512_and_si512(h.l0, m44);
  h.l1 = _mm512_add_epi64(h.l1, c);
  return h;
}

/* Eight consecutive blocks, block j in lane j. */
SC_IFMA static inline ScPolyVec sc_poly_vload(const uint8_t *m) {
  const __m512i m44 = _mm512_set1_epi64((long long)SC_M44), m42 = _mm512_set1_epi64((long long)SC_M42);
  __m512i q0 = _mm512_loadu_si512((const void *)m), q1 = _mm512_loadu_si512((const void *)(m + 64));
  __m512i t0 = _mm512_permutex2var_epi64(q0, _mm512_set_epi64(14, 12, 10, 8, 6, 4, 2, 0), q1);
  __m512i t1 = _mm512_permutex2var_epi64(q0, _mm512_set_epi64(15, 13, 11, 9, 7, 5, 3, 1), q1);
  ScPolyVec v;
  v.l0 = _mm512_and_si512(t0, m44);
  v.l1 = _mm512_and_si512(_mm512_or_si512(_mm512_srli_epi64(t0, 44), _mm512_slli_epi64(t1, 20)), m44);
  v.l2 = _mm512_or_si512(_mm512_and_si512(_mm512_srli_epi64(t1, 24), m42), _mm512_set1_epi64(1LL << 40));
  return v;
}

/* `groups` runs of eight full blocks. Lane j accumulates blocks j, j + 8,
 * ... by Horner's rule in r^8, so h = Σ lane_j · r^(8 - j). */
SC_IFMA static void sc_poly_ifma(ScCsPoly1305 *p, const uint8_t *m, size_t groups) {
  const uint64_t (*rp)[3] = (const uint64_t (*)[3])p->rp;
  ScPolyVec r8 = {_mm512_set1_epi64((long long)rp[7][0]), _mm512_set1_epi64((long long)rp[7][1]),
                  _mm512_set1_epi64((long long)rp[7][2])};
  ScPolyVec a = sc_poly_vload(m);
  a.l0 = _mm512_add_epi64(a.l0, _mm512_set_epi64(0, 0, 0, 0, 0, 0, 0, (long long)p->h[0]));
  a.l1 = _mm512_add_epi64(a.l1, _mm512_set_epi64(0, 0, 0, 0, 0, 0, 0, (long long)p->h[1]));
  a.l2 = _mm512_add_epi64(a.l2, _mm512_set_epi64(0, 0, 0, 0, 0, 0, 0, (long long)p->h[2]));
  for (size_t g = 1; g < groups; g++) {
    a = sc_poly_vmul(a, r8);
    ScPolyVec b = sc_poly_vload(m + 128 * g);
    a.l0 = _mm512_add_epi64(a.l0, b.l0);
    a.l1 = _mm512_add_epi64(a.l1, b.l1);
    a.l2 = _mm512_add_epi64(a.l2, b.l2);
  }
#define SC_POW(k) _mm512_set_epi64((long long)rp[0][k], (long long)rp[1][k], (long long)rp[2][k], (long long)rp[3][k], \
                                   (long long)rp[4][k], (long long)rp[5][k], (long long)rp[6][k], (long long)rp[7][k])
  ScPolyVec powers = {SC_POW(0), SC_POW(1), SC_POW(2)};
#undef SC_POW
  a = sc_poly_vmul(a, powers);
  sc_poly_carry((sc_u128)(uint64_t)_mm512_reduce_add_epi64(a.l0), (sc_u128)(uint64_t)_mm512_reduce_add_epi64(a.l1),
                (sc_u128)(uint64_t)_mm512_reduce_add_epi64(a.l2), p->h);
}

void scr_cs_poly_start(ScCsPoly1305 *p, const uint8_t key[32]) {
  uint64_t t0 = sc_le64(key), t1 = sc_le64(key + 8);
  p->r[0] = t0 & 0xffc0fffffffULL;
  p->r[1] = ((t0 >> 44) | (t1 << 20)) & 0xfffffc0ffffULL;
  p->r[2] = (t1 >> 24) & 0x00ffffffc0fULL;
  p->h[0] = p->h[1] = p->h[2] = 0;
  sc_u128 d[3] = {0, 0, 0};
  sc_poly_mul_acc(p->r, p->r, d);
  sc_poly_carry(d[0], d[1], d[2], p->r2);
  d[0] = d[1] = d[2] = 0;
  sc_poly_mul_acc(p->r2, p->r, d);
  sc_poly_carry(d[0], d[1], d[2], p->r3);
  d[0] = d[1] = d[2] = 0;
  sc_poly_mul_acc(p->r2, p->r2, d);
  sc_poly_carry(d[0], d[1], d[2], p->r4);
  p->wide = (sc_vector_features() & 4) != 0;
  if (p->wide) {
    /* rp[k] = r^(k + 1). */
    memcpy(p->rp[0], p->r, sizeof p->r);
    for (int k = 1; k < 8; k++) {
      d[0] = d[1] = d[2] = 0;
      sc_poly_mul_acc(p->rp[k - 1], p->r, d);
      sc_poly_carry(d[0], d[1], d[2], p->rp[k]);
    }
  }
  p->pad[0] = sc_le64(key + 16);
  p->pad[1] = sc_le64(key + 24);
  p->leftover = 0;
}

void scr_cs_poly_update(ScCsPoly1305 *p, const uint8_t *m, size_t len) {
  if (p->leftover) {
    size_t take = 16 - p->leftover < len ? 16 - p->leftover : len;
    memcpy(p->buf + p->leftover, m, take);
    p->leftover += take;
    m += take;
    len -= take;
    if (p->leftover < 16) return;
    sc_poly_blocks(p, p->buf, 16, 1ULL << 40);
    p->leftover = 0;
  }
  if (p->wide && len >= 256) {
    size_t groups = len / 128;
    sc_poly_ifma(p, m, groups);
    m += 128 * groups;
    len -= 128 * groups;
  }
  if (len >= 16) {
    size_t whole = len & ~(size_t)15;
    sc_poly_blocks(p, m, whole, 1ULL << 40);
    m += whole;
    len -= whole;
  }
  if (len) {
    memcpy(p->buf, m, len);
    p->leftover = len;
  }
}

void scr_cs_poly_finish(ScCsPoly1305 *p, uint8_t mac[16]) {
  if (p->leftover) {
    p->buf[p->leftover] = 1;
    memset(p->buf + p->leftover + 1, 0, 15 - p->leftover);
    sc_poly_blocks(p, p->buf, 16, 0);
  }
  uint64_t h0 = p->h[0], h1 = p->h[1], h2 = p->h[2], c;
  c = h1 >> 44; h1 &= SC_M44; h2 += c;
  c = h2 >> 42; h2 &= SC_M42; h0 += c * 5;
  c = h0 >> 44; h0 &= SC_M44; h1 += c;
  c = h1 >> 44; h1 &= SC_M44; h2 += c;
  c = h2 >> 42; h2 &= SC_M42; h0 += c * 5;
  c = h0 >> 44; h0 &= SC_M44; h1 += c;
  /* h - p, selected without a branch when it does not underflow. */
  uint64_t g0 = h0 + 5;
  c = g0 >> 44; g0 &= SC_M44;
  uint64_t g1 = h1 + c;
  c = g1 >> 44; g1 &= SC_M44;
  uint64_t g2 = h2 + c - (1ULL << 42);
  c = (g2 >> 63) - 1;
  g0 &= c; g1 &= c; g2 &= c;
  c = ~c;
  h0 = (h0 & c) | g0;
  h1 = (h1 & c) | g1;
  h2 = (h2 & c) | g2;
  uint64_t t0 = p->pad[0], t1 = p->pad[1];
  h0 += t0 & SC_M44;
  c = h0 >> 44; h0 &= SC_M44;
  h1 += (((t0 >> 44) | (t1 << 20)) & SC_M44) + c;
  c = h1 >> 44; h1 &= SC_M44;
  h2 += ((t1 >> 24) & SC_M42) + c;
  h2 &= SC_M42;
  sc_put_le64(mac, h0 | (h1 << 44));
  sc_put_le64(mac + 8, (h1 >> 20) | (h2 << 24));
  memset(p, 0, sizeof *p);
}

/* ── ChaCha20 ─────────────────────────────────────────────────────────── */

static inline uint32_t sc_rotl(uint32_t v, int n) {
  return (v << n) | (v >> (32 - n));
}

#define SC_QR(x, a, b, c, d)                \
  do {                                      \
    x[a] += x[b]; x[d] = sc_rotl(x[d] ^ x[a], 16); \
    x[c] += x[d]; x[b] = sc_rotl(x[b] ^ x[c], 12); \
    x[a] += x[b]; x[d] = sc_rotl(x[d] ^ x[a], 8);  \
    x[c] += x[d]; x[b] = sc_rotl(x[b] ^ x[c], 7);  \
  } while (0)

static void sc_chacha_block(uint32_t state[16], uint8_t out[64]) {
  uint32_t x[16];
  memcpy(x, state, sizeof x);
  for (int i = 0; i < 10; i++) {
    SC_QR(x, 0, 4, 8, 12);
    SC_QR(x, 1, 5, 9, 13);
    SC_QR(x, 2, 6, 10, 14);
    SC_QR(x, 3, 7, 11, 15);
    SC_QR(x, 0, 5, 10, 15);
    SC_QR(x, 1, 6, 11, 12);
    SC_QR(x, 2, 7, 8, 13);
    SC_QR(x, 3, 4, 9, 14);
  }
  for (int i = 0; i < 16; i++) sc_put_le32(out + 4 * i, x[i] + state[i]);
  state[12]++;
}

SC_AVX2 static inline __m256i sc_rotl256(__m256i v, int n) {
  return _mm256_or_si256(_mm256_slli_epi32(v, n), _mm256_srli_epi32(v, 32 - n));
}

/* Eight blocks with one block per 32-bit lane, then a transpose back to
 * byte order. */
SC_AVX2 static void sc_chacha8(uint32_t state[16], const uint8_t *in, uint8_t *out) {
  const __m256i rot16 = _mm256_set_epi8(13, 12, 15, 14, 9, 8, 11, 10, 5, 4, 7, 6, 1, 0, 3, 2,
                                        13, 12, 15, 14, 9, 8, 11, 10, 5, 4, 7, 6, 1, 0, 3, 2);
  const __m256i rot8 = _mm256_set_epi8(14, 13, 12, 15, 10, 9, 8, 11, 6, 5, 4, 7, 2, 1, 0, 3,
                                       14, 13, 12, 15, 10, 9, 8, 11, 6, 5, 4, 7, 2, 1, 0, 3);
  __m256i s[16], x[16];
  for (int j = 0; j < 16; j++) s[j] = _mm256_set1_epi32((int)state[j]);
  s[12] = _mm256_add_epi32(s[12], _mm256_set_epi32(7, 6, 5, 4, 3, 2, 1, 0));
  for (int j = 0; j < 16; j++) x[j] = s[j];
#define SC_QR8(a, b, c, d)                                                    \
  do {                                                                        \
    x[a] = _mm256_add_epi32(x[a], x[b]);                                      \
    x[d] = _mm256_shuffle_epi8(_mm256_xor_si256(x[d], x[a]), rot16);          \
    x[c] = _mm256_add_epi32(x[c], x[d]);                                      \
    x[b] = sc_rotl256(_mm256_xor_si256(x[b], x[c]), 12);                      \
    x[a] = _mm256_add_epi32(x[a], x[b]);                                      \
    x[d] = _mm256_shuffle_epi8(_mm256_xor_si256(x[d], x[a]), rot8);           \
    x[c] = _mm256_add_epi32(x[c], x[d]);                                      \
    x[b] = sc_rotl256(_mm256_xor_si256(x[b], x[c]), 7);                       \
  } while (0)
  for (int i = 0; i < 10; i++) {
    SC_QR8(0, 4, 8, 12);
    SC_QR8(1, 5, 9, 13);
    SC_QR8(2, 6, 10, 14);
    SC_QR8(3, 7, 11, 15);
    SC_QR8(0, 5, 10, 15);
    SC_QR8(1, 6, 11, 12);
    SC_QR8(2, 7, 8, 13);
    SC_QR8(3, 4, 9, 14);
  }
#undef SC_QR8
  for (int j = 0; j < 16; j++) x[j] = _mm256_add_epi32(x[j], s[j]);
  for (int half = 0; half < 2; half++) {
    __m256i *a = x + 8 * half;
    __m256i t0 = _mm256_unpacklo_epi32(a[0], a[1]), t1 = _mm256_unpackhi_epi32(a[0], a[1]);
    __m256i t2 = _mm256_unpacklo_epi32(a[2], a[3]), t3 = _mm256_unpackhi_epi32(a[2], a[3]);
    __m256i t4 = _mm256_unpacklo_epi32(a[4], a[5]), t5 = _mm256_unpackhi_epi32(a[4], a[5]);
    __m256i t6 = _mm256_unpacklo_epi32(a[6], a[7]), t7 = _mm256_unpackhi_epi32(a[6], a[7]);
    __m256i u0 = _mm256_unpacklo_epi64(t0, t2), u1 = _mm256_unpackhi_epi64(t0, t2);
    __m256i u2 = _mm256_unpacklo_epi64(t1, t3), u3 = _mm256_unpackhi_epi64(t1, t3);
    __m256i u4 = _mm256_unpacklo_epi64(t4, t6), u5 = _mm256_unpackhi_epi64(t4, t6);
    __m256i u6 = _mm256_unpacklo_epi64(t5, t7), u7 = _mm256_unpackhi_epi64(t5, t7);
    __m256i rows[8] = {
      _mm256_permute2x128_si256(u0, u4, 0x20), _mm256_permute2x128_si256(u1, u5, 0x20),
      _mm256_permute2x128_si256(u2, u6, 0x20), _mm256_permute2x128_si256(u3, u7, 0x20),
      _mm256_permute2x128_si256(u0, u4, 0x31), _mm256_permute2x128_si256(u1, u5, 0x31),
      _mm256_permute2x128_si256(u2, u6, 0x31), _mm256_permute2x128_si256(u3, u7, 0x31),
    };
    for (int k = 0; k < 8; k++) {
      size_t at = 64 * (size_t)k + 32 * (size_t)half;
      __m256i d = _mm256_loadu_si256((const __m256i *)(in + at));
      _mm256_storeu_si256((__m256i *)(out + at), _mm256_xor_si256(d, rows[k]));
    }
  }
  state[12] += 8;
}

/* Sixteen blocks with one block per 32-bit lane. After the rounds, each
 * 128-bit lane of a group of four word vectors is transposed so the lane
 * holds four words of one block, then the four groups are interleaved by
 * 128-bit lane into whole blocks. */
SC_AVX512 static void sc_chacha16(uint32_t state[16], const uint8_t *in, uint8_t *out) {
  __m512i s[16], x[16];
  for (int j = 0; j < 16; j++) s[j] = _mm512_set1_epi32((int)state[j]);
  s[12] = _mm512_add_epi32(s[12], _mm512_set_epi32(15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0));
  for (int j = 0; j < 16; j++) x[j] = s[j];
#define SC_QR16(a, b, c, d)                                          \
  do {                                                               \
    x[a] = _mm512_add_epi32(x[a], x[b]);                             \
    x[d] = _mm512_rol_epi32(_mm512_xor_si512(x[d], x[a]), 16);       \
    x[c] = _mm512_add_epi32(x[c], x[d]);                             \
    x[b] = _mm512_rol_epi32(_mm512_xor_si512(x[b], x[c]), 12);       \
    x[a] = _mm512_add_epi32(x[a], x[b]);                             \
    x[d] = _mm512_rol_epi32(_mm512_xor_si512(x[d], x[a]), 8);        \
    x[c] = _mm512_add_epi32(x[c], x[d]);                             \
    x[b] = _mm512_rol_epi32(_mm512_xor_si512(x[b], x[c]), 7);        \
  } while (0)
  for (int i = 0; i < 10; i++) {
    SC_QR16(0, 4, 8, 12);
    SC_QR16(1, 5, 9, 13);
    SC_QR16(2, 6, 10, 14);
    SC_QR16(3, 7, 11, 15);
    SC_QR16(0, 5, 10, 15);
    SC_QR16(1, 6, 11, 12);
    SC_QR16(2, 7, 8, 13);
    SC_QR16(3, 4, 9, 14);
  }
#undef SC_QR16
  for (int j = 0; j < 16; j++) x[j] = _mm512_add_epi32(x[j], s[j]);
  /* u[g][i]: lane l holds words 4g..4g+3 of block 4l+i. */
  __m512i u[4][4];
  for (int g = 0; g < 4; g++) {
    __m512i *a = x + 4 * g;
    __m512i t0 = _mm512_unpacklo_epi32(a[0], a[1]), t1 = _mm512_unpackhi_epi32(a[0], a[1]);
    __m512i t2 = _mm512_unpacklo_epi32(a[2], a[3]), t3 = _mm512_unpackhi_epi32(a[2], a[3]);
    u[g][0] = _mm512_unpacklo_epi64(t0, t2);
    u[g][1] = _mm512_unpackhi_epi64(t0, t2);
    u[g][2] = _mm512_unpacklo_epi64(t1, t3);
    u[g][3] = _mm512_unpackhi_epi64(t1, t3);
  }
  for (int i = 0; i < 4; i++) {
    __m512i t0 = _mm512_shuffle_i32x4(u[0][i], u[1][i], 0x44), t1 = _mm512_shuffle_i32x4(u[0][i], u[1][i], 0xee);
    __m512i t2 = _mm512_shuffle_i32x4(u[2][i], u[3][i], 0x44), t3 = _mm512_shuffle_i32x4(u[2][i], u[3][i], 0xee);
    __m512i blocks[4] = {
      _mm512_shuffle_i32x4(t0, t2, 0x88), _mm512_shuffle_i32x4(t0, t2, 0xdd),
      _mm512_shuffle_i32x4(t1, t3, 0x88), _mm512_shuffle_i32x4(t1, t3, 0xdd),
    };
    for (int l = 0; l < 4; l++) {
      size_t at = 64 * (size_t)(4 * l + i);
      __m512i d = _mm512_loadu_si512((const void *)(in + at));
      _mm512_storeu_si512((void *)(out + at), _mm512_xor_si512(d, blocks[l]));
    }
  }
  state[12] += 16;
}


void scr_cs_chacha_start(ScCsChaCha *c, const uint8_t key[32], const uint8_t nonce[12], uint32_t counter) {
  c->wide = (sc_vector_features() & 2) != 0;
  c->state[0] = 0x61707865;
  c->state[1] = 0x3320646e;
  c->state[2] = 0x79622d32;
  c->state[3] = 0x6b206574;
  for (int i = 0; i < 8; i++) c->state[4 + i] = sc_le32(key + 4 * i);
  c->state[12] = counter;
  for (int i = 0; i < 3; i++) c->state[13 + i] = sc_le32(nonce + 4 * i);
  c->used = 64;
  c->blocks = (uint64_t)UINT32_MAX + 1 - counter;
}

bool scr_cs_chacha_xor(ScCsChaCha *c, const uint8_t *in, uint8_t *out, size_t len) {
  /* Every block below is generated in this call, so the whole request is
   * checked against the counter first: no block, including a lane of the
   * eight- and sixteen-block kernels, runs past counter 2^32 - 1. */
  uint64_t left = 64 - c->used;
  if ((uint64_t)len > left) {
    uint64_t rest = (uint64_t)len - left;
    uint64_t need = rest / 64 + (rest % 64 != 0);
    if (need > c->blocks) return false;
    c->blocks -= need;
  }
  while (c->used < 64 && len > 0) {
    *out++ = *in++ ^ c->stream[c->used++];
    len--;
  }
  while (c->wide && len >= 1024) {
    sc_chacha16(c->state, in, out);
    in += 1024;
    out += 1024;
    len -= 1024;
  }
  while (len >= 512) {
    sc_chacha8(c->state, in, out);
    in += 512;
    out += 512;
    len -= 512;
  }
  while (len >= 64) {
    uint8_t block[64];
    sc_chacha_block(c->state, block);
    for (int i = 0; i < 64; i++) out[i] = in[i] ^ block[i];
    in += 64;
    out += 64;
    len -= 64;
  }
  if (len > 0) {
    sc_chacha_block(c->state, c->stream);
    for (size_t i = 0; i < len; i++) out[i] = in[i] ^ c->stream[i];
    c->used = len;
  }
  return true;
}

#else

bool scr_cs_aes_available(void) { return false; }
bool scr_cs_chacha_available(void) { return false; }
void scr_cs_aes_setkey(ScCsAesKey *enc, ScCsAesKey *dec, const uint8_t *key, size_t key_len) {
  (void)enc; (void)dec; (void)key; (void)key_len;
}
void scr_cs_aes_ctr(const ScCsAesKey *key, uint8_t counter[16], uint8_t stream[16], size_t *offset,
                    const uint8_t *in, uint8_t *out, size_t len) {
  (void)key; (void)counter; (void)stream; (void)offset; (void)in; (void)out; (void)len;
}
void scr_cs_aes_cbc_encrypt(const ScCsAesKey *enc, uint8_t iv[16], const uint8_t *in, uint8_t *out,
                            size_t blocks) {
  (void)enc; (void)iv; (void)in; (void)out; (void)blocks;
}
void scr_cs_aes_cbc_decrypt(const ScCsAesKey *dec, uint8_t iv[16], const uint8_t *in, uint8_t *out,
                            size_t blocks) {
  (void)dec; (void)iv; (void)in; (void)out; (void)blocks;
}
void scr_cs_gcm_start(ScCsGcm *g, const uint8_t *key, size_t key_len, const uint8_t *iv, size_t iv_len,
                      bool decrypt) {
  (void)g; (void)key; (void)key_len; (void)iv; (void)iv_len; (void)decrypt;
}
bool scr_cs_gcm_aad(ScCsGcm *g, const uint8_t *aad, size_t len) {
  (void)g; (void)aad; (void)len;
  return false;
}
bool scr_cs_gcm_update(ScCsGcm *g, const uint8_t *in, uint8_t *out, size_t len) {
  (void)g; (void)in; (void)out; (void)len;
  return false;
}
void scr_cs_gcm_finish(ScCsGcm *g, uint8_t tag[16]) { (void)g; (void)tag; }
void scr_cs_chacha_start(ScCsChaCha *c, const uint8_t key[32], const uint8_t nonce[12], uint32_t counter) {
  (void)c; (void)key; (void)nonce; (void)counter;
}
bool scr_cs_chacha_xor(ScCsChaCha *c, const uint8_t *in, uint8_t *out, size_t len) {
  (void)c; (void)in; (void)out; (void)len;
  return false;
}
void scr_cs_poly_start(ScCsPoly1305 *p, const uint8_t key[32]) { (void)p; (void)key; }
void scr_cs_poly_update(ScCsPoly1305 *p, const uint8_t *m, size_t len) { (void)p; (void)m; (void)len; }
void scr_cs_poly_finish(ScCsPoly1305 *p, uint8_t mac[16]) { (void)p; (void)mac; }


#endif

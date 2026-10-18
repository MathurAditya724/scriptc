/* x86-64 cipher kernels for scr_cipher.c: AES-NI key schedules, CTR and
 * CBC; AES-GCM with PCLMULQDQ GHASH, or VAES and VPCLMULQDQ; ChaCha20 (AVX2 or AVX-512F); and
 * Poly1305 (scalar, or AVX-512 IFMA).
 * scr_cipher.c uses them when scr_cs_aes_available() or
 * scr_cs_chacha_available() reports CPU support at run time and the
 * mbedTLS implementations otherwise. Both produce the same output; the
 * runtime C test checks each against Node-generated vectors. The header
 * does not depend on scr_runtime.h so the test can link the unit alone. */
#ifndef SCR_CIPHER_SIMD_H
#define SCR_CIPHER_SIMD_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* AES-NI, PCLMULQDQ, SSSE3 and SSE4.1. AES-GCM also uses VAES and
 * VPCLMULQDQ with AVX-512BW when they are available. */
bool scr_cs_aes_available(void);
/* AVX2 with operating-system support for the YMM state. ChaCha20 also
 * uses AVX-512F, and Poly1305 AVX-512 IFMA, when they are available. */
bool scr_cs_chacha_available(void);

/* An expanded AES key: rounds + 1 round keys of 16 bytes. */
typedef struct {
  uint8_t rk[15 * 16];
  unsigned rounds;
} ScCsAesKey;

/* Expands a 16, 24 or 32-byte key. `dec` (optional) receives the
 * equivalent inverse schedule for decryption. */
void scr_cs_aes_setkey(ScCsAesKey *enc, ScCsAesKey *dec, const uint8_t *key, size_t key_len);

/* CTR with a 128-bit big-endian counter, keeping mbedtls_aes_crypt_ctr's
 * state: `stream` holds the last keystream block and `*offset` the next
 * unused byte in it (0 when a new block is needed). */
void scr_cs_aes_ctr(const ScCsAesKey *key, uint8_t counter[16], uint8_t stream[16], size_t *offset,
                    const uint8_t *in, uint8_t *out, size_t len);

/* CBC over whole blocks; `iv` is updated to the last ciphertext block. */
void scr_cs_aes_cbc_encrypt(const ScCsAesKey *enc, uint8_t iv[16], const uint8_t *in, uint8_t *out,
                            size_t blocks);
void scr_cs_aes_cbc_decrypt(const ScCsAesKey *dec, uint8_t iv[16], const uint8_t *in, uint8_t *out,
                            size_t blocks);

/* Streaming AES-GCM. AAD must be added before the first non-empty update. */
typedef struct {
  ScCsAesKey key;
  uint8_t h[16][16];    /* H^1 .. H^16, byte-reflected */
  uint8_t j0[16];
  uint8_t x[16];        /* GHASH accumulator, byte-reflected */
  uint8_t partial[16];  /* GHASH input not yet folded */
  size_t partial_len;
  uint8_t stream[16];   /* keystream block of a partial data block */
  size_t stream_off;    /* next unused byte in `stream`; 16 when none */
  uint32_t counter;     /* next 32-bit block counter */
  uint64_t aad_len;
  uint64_t text_len;
  bool decrypt;
  bool data;
  bool wide; /* VAES and VPCLMULQDQ: sixteen blocks per step */
} ScCsGcm;

void scr_cs_gcm_start(ScCsGcm *g, const uint8_t *key, size_t key_len, const uint8_t *iv, size_t iv_len,
                      bool decrypt);
/* AAD and update return false, changing nothing, past GCM's limits:
 * 2^61 bytes of AAD and SC_GCM_MAX_TEXT bytes of data. */
#define SC_GCM_MAX_TEXT 0xFFFFFFFE0ull
bool scr_cs_gcm_aad(ScCsGcm *g, const uint8_t *aad, size_t len);
bool scr_cs_gcm_update(ScCsGcm *g, const uint8_t *in, uint8_t *out, size_t len);
void scr_cs_gcm_finish(ScCsGcm *g, uint8_t tag[16]);

/* RFC 8439 ChaCha20 with a 32-bit block counter and a 96-bit nonce. */
typedef struct {
  uint32_t state[16];
  uint8_t stream[64];
  size_t used;     /* bytes of `stream` already used; 64 when none are left */
  uint64_t blocks; /* keystream blocks left before the counter would wrap */
  bool wide;       /* AVX-512F: sixteen blocks per step instead of eight */
} ScCsChaCha;

void scr_cs_chacha_start(ScCsChaCha *c, const uint8_t key[32], const uint8_t nonce[12], uint32_t counter);
/* XORs len bytes with the keystream. Returns false, writing nothing and
 * changing nothing, when the bytes need a block past counter 2^32 - 1,
 * as mbedtls_chacha20_update() refuses the same input. */
bool scr_cs_chacha_xor(ScCsChaCha *c, const uint8_t *in, uint8_t *out, size_t len);

/* Poly1305 with 44-bit limbs; eight lanes with AVX-512 IFMA when available. */
typedef struct {
  uint64_t r[3];
  uint64_t r2[3]; /* r^2, r^3 and r^4, partially reduced */
  uint64_t r3[3];
  uint64_t r4[3];
  uint64_t h[3];
  uint64_t pad[2];
  uint64_t rp[8][3]; /* r^1 .. r^8 for the AVX-512 IFMA kernel */
  uint8_t buf[16];
  size_t leftover;
  bool wide; /* AVX-512 IFMA: eight blocks per step */
} ScCsPoly1305;

void scr_cs_poly_start(ScCsPoly1305 *p, const uint8_t key[32]);
void scr_cs_poly_update(ScCsPoly1305 *p, const uint8_t *m, size_t len);
void scr_cs_poly_finish(ScCsPoly1305 *p, uint8_t mac[16]);


#endif

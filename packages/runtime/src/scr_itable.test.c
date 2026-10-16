#undef NDEBUG
#include "scr_runtime.h"
#include <assert.h>
#include <pthread.h>
#include <sched.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* The table unit needs only scr_trap from the rest of the runtime. */
_Noreturn void scr_trap(const char *msg) {
  fputs(msg, stderr);
  abort();
}

enum { THREADS = 8, KEYS = 20000, ROUNDS = 3 };

/* A stand-in for a published value: written by its creator before the
 * insert, read by every thread that finds it. */
typedef struct {
  uint64_t key;
  unsigned creator;
} Value;

static ScrStr *make_str(const char *text) {
  size_t len = strlen(text);
  ScrStr *s = calloc(1, sizeof(ScrStr) + len + 1);
  assert(s);
  s->rc = 1;
  s->len = len;
  s->cap = len;
  memcpy(s->data, text, len + 1);
  return s;
}

static void key_text(char *out, size_t size, uint64_t k) { snprintf(out, size, "key-%llu", (unsigned long long)k); }

static ScrITable *strings, *numbers;
static const ScrITableEntry *seen_str[THREADS][KEYS];
static atomic_uint ready;

static void check_value(const ScrITableEntry *e, uint64_t k) {
  const Value *v = (const Value *)(uintptr_t)e->value;
  assert(v->key == k && v->creator < THREADS);
}

static void *run(void *arg) {
  unsigned id = (unsigned)(uintptr_t)arg;
  atomic_fetch_add_explicit(&ready, 1, memory_order_acq_rel);
  while (atomic_load_explicit(&ready, memory_order_acquire) != THREADS) sched_yield();
  char text[32];
  for (unsigned round = 0; round < ROUNDS; round++) {
    /* Every thread visits every key, from a different starting point, so
     * each key is inserted by racing threads while others look it up. */
    for (unsigned n = 0; n < KEYS; n++) {
      uint64_t k = (n * 7919u + id * (KEYS / THREADS) + round * 31u) % KEYS;
      key_text(text, sizeof text, k);
      ScrStr *key = make_str(text);
      const ScrITableEntry *e = scr_itable_find_str(strings, key);
      if (!e) {
        Value *v = malloc(sizeof *v);
        assert(v);
        v->key = k;
        v->creator = id;
        e = scr_itable_insert_str(strings, key, (uint64_t)(uintptr_t)v);
        if ((const Value *)(uintptr_t)e->value != v) free(v); /* lost the race */
      }
      check_value(e, k);
      assert(seen_str[id][k] == NULL || seen_str[id][k] == e);
      seen_str[id][k] = e;
      free(key);

      double dk = (double)k - KEYS / 2;
      const ScrITableEntry *f = scr_itable_find_f64(numbers, dk);
      if (!f) f = scr_itable_insert_f64(numbers, dk, (uint64_t)k * 3);
      /* Number entries live in the index, so a grown index answers a new
       * handle with the same value. */
      assert(f->value == k * 3);
      /* A lookup of a key no thread inserts misses. */
      assert(!scr_itable_find_f64(numbers, (double)KEYS + 0.5 + n));
    }
  }
  return NULL;
}

int main(void) {
  ScrStr *name = make_str("strings");
  strings = scr_itable_open(name, SCR_ITABLE_KEY_STR);
  assert(scr_itable_open(name, SCR_ITABLE_KEY_STR) == strings);
  ScrStr *other = make_str("numbers");
  numbers = scr_itable_open(other, SCR_ITABLE_KEY_F64);
  assert(numbers != strings);

  /* Number keys use SameValueZero; the first insertion wins. */
  ScrStr *zeros_name = make_str("zeros"), *texts_name = make_str("texts");
  ScrITable *zeros = scr_itable_open(zeros_name, SCR_ITABLE_KEY_F64);
  assert(scr_itable_insert_f64(zeros, -0.0, 1) == scr_itable_insert_f64(zeros, 0.0, 2));
  assert(scr_itable_find_f64(zeros, 0.0)->value == 1);
  assert(scr_itable_insert_f64(zeros, 0.0 / 0.0, 3) == scr_itable_find_f64(zeros, -(0.0 / 0.0)));
  assert(scr_itable_size(zeros) == 2);
  ScrStr *empty = make_str("");
  ScrITable *texts = scr_itable_open(texts_name, SCR_ITABLE_KEY_STR);
  assert(!scr_itable_find_str(texts, empty));
  const ScrITableEntry *e = scr_itable_insert_str(texts, empty, 9);
  assert(scr_itable_find_str(texts, empty) == e && e->value == 9);
  assert(scr_itable_insert_str(texts, empty, 10) == e && e->value == 9);
  free(empty);
  free(texts_name);
  free(zeros_name);
  free(other);
  free(name);

  pthread_t threads[THREADS];
  for (unsigned i = 0; i < THREADS; i++)
    assert(pthread_create(&threads[i], NULL, run, (void *)(uintptr_t)i) == 0);
  for (unsigned i = 0; i < THREADS; i++) assert(pthread_join(threads[i], NULL) == 0);

  /* Every thread received the same string entry for every key. */
  for (unsigned k = 0; k < KEYS; k++)
    for (unsigned i = 1; i < THREADS; i++) assert(seen_str[i][k] == seen_str[0][k]);
  assert(scr_itable_size(strings) == KEYS);
  assert(scr_itable_size(numbers) == KEYS);
  printf("intern tables share one entry per key across racing inserts and lookups\n");
  return 0;
}

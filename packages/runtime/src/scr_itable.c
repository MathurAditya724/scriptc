/* Shared intern tables (@scriptc/experimental InternTable); the contract is
 * in scr_itable.h.
 *
 * A table is SCR_ITABLE_SEGMENTS independent segments. The top bits of a
 * key's 64-bit hash pick the segment and the low bits the first slot of a
 * linear probe in the segment's index. Number tables keep each key and its
 * value in the index slot itself, so a lookup touches one slot per probe.
 * String tables keep entries (value, hash and key bytes) in chunks owned by
 * the segment; their slots hold the entry pointer with a tag of hash bits
 * 50..57 in bits 48..55, so a probe reads an entry only when the tags match.
 *
 * Readers load the segment's index pointer, then slots with acquire order,
 * and never write. Writers hold the segment's lock: they probe again, grow
 * the index when an insert would fill more than half of it, fill in the
 * value (and the entry), and store the slot's last word with release order.
 * A grown index is complete before its pointer is stored with release
 * order, and a reader that still holds the previous one sees every key
 * stored before the growth. Replaced indexes are kept on the segment's
 * retired list, because readers may still be probing them (and number
 * handles point into them); their total size stays below the current
 * index's.
 *
 * Nothing here is freed. Every allocation is reachable from the static
 * registry, so leak checkers report none of it. */

#include "scr_runtime.h"
#include "scr_itable.h"
#include "scr_key.h"

#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>

#if defined(_WIN32)
#include <windows.h>
#elif !defined(__wasi__) && !defined(__wasm__)
#include <sched.h>
#endif

#define SCR_ITABLE_SEGMENT_BITS 6
#define SCR_ITABLE_SEGMENTS (1u << SCR_ITABLE_SEGMENT_BITS)
#define SCR_ITABLE_FIRST_SLOTS 8u
#define SCR_ITABLE_FIRST_CHUNK ((size_t)512)
#define SCR_ITABLE_MAX_CHUNK ((size_t)64 << 10)

/* String slots: 0 is empty; otherwise the entry pointer with the tag in
 * bits 48..55, which no supported target uses for user-space addresses
 * (tagged heap pointers keep their tag in the top byte, which is kept). */
#define SCR_ITABLE_TAG_SHIFT 48
#define SCR_ITABLE_TAG_MASK ((uint64_t)0xff << SCR_ITABLE_TAG_SHIFT)

/* Number slots are { value, key }, with the key stored as its normalized
 * bits XOR this NaN pattern, which normalization never produces: a zero
 * key word is an empty slot. */
#define SCR_ITABLE_F64_FLIP UINT64_C(0x7ff4000000000001)

typedef struct ScrITableIndex {
  uint64_t mask;                  /* slots - 1 */
  struct ScrITableIndex *retired; /* the index this one replaced */
  _Atomic uint64_t words[];       /* one word per string slot, two per number slot */
} ScrITableIndex;

/* A string table entry: the value slot first (scr_itable.h). */
typedef struct {
  uint64_t value;
  uint64_t hash;
  uint32_t len;
  char data[];
} ScrITableStrEntry;

typedef struct ScrITableChunk {
  struct ScrITableChunk *next;
  size_t size;
  size_t used;
  _Alignas(8) char data[];
} ScrITableChunk;

/* Lookups read only `index`, which changes when the index grows; inserts
 * write the rest. The two halves sit on separate cache lines, so inserts
 * into a segment do not evict its index pointer from readers' caches. */
typedef struct {
  _Alignas(64) ScrITableIndex *_Atomic index;
  _Alignas(64) atomic_uint lock;
  _Atomic uint64_t count;
  ScrITableChunk *chunks; /* the newest first */
} ScrITableSegment;

struct ScrITable {
  ScrITableSegment segments[SCR_ITABLE_SEGMENTS];
  struct ScrITable *next; /* the registry list */
  int key_kind;
  size_t name_len;
  char name[];
};

static void scr_itable_oom(void) { scr_trap("scriptc: out of memory\n"); }

static inline void scr_itable_pause(void) {
#if defined(__x86_64__) || defined(__i386__)
  __builtin_ia32_pause();
#elif defined(__aarch64__)
  __asm__ __volatile__("yield");
#endif
}

static void scr_itable_yield(void) {
#if defined(_WIN32)
  SwitchToThread();
#elif !defined(__wasi__) && !defined(__wasm__)
  sched_yield();
#endif
}

static void scr_itable_lock(atomic_uint *lock) {
  unsigned spins = 0;
  while (atomic_exchange_explicit(lock, 1, memory_order_acquire)) {
    while (atomic_load_explicit(lock, memory_order_relaxed)) {
      if (++spins < 64) scr_itable_pause();
      else scr_itable_yield();
    }
  }
}

static void scr_itable_unlock(atomic_uint *lock) {
  atomic_store_explicit(lock, 0, memory_order_release);
}

/* ── keys and hashes ─────────────────────────────────────────────────── */

static inline uint64_t scr_itable_f64_bits(double k) {
  if (k != k) return UINT64_C(0x7ff8000000000000); /* one NaN key */
  if (k == 0) k = 0;                                /* -0 is the key 0 */
  uint64_t bits;
  memcpy(&bits, &k, sizeof bits);
  return bits;
}

static inline uint64_t scr_itable_f64_hash(uint64_t stored) { return scr_key_mix(stored); }

/* The Map key hash of a string (scr_map.c), which heap strings cache in
 * their header: a key used with a Map or a table before hashes once. */
static uint32_t scr_itable_str_hash32(const ScrStr *s) {
#if SCR_STR_HASH_CACHE
  uint32_t h = s->hash;
  if (h != 0) return h;
#endif
  uint64_t wide = scr_key_hash(s->data, s->len);
  uint32_t folded = (uint32_t)(wide ^ (wide >> 32));
  if (folded == 0) folded = 1;
#if SCR_STR_HASH_CACHE
  if (s->rc != SIZE_MAX) ((ScrStr *)s)->hash = folded;
#endif
  return folded;
}

static inline uint64_t scr_itable_str_hash(const ScrStr *s) {
  return scr_key_mix((uint64_t)scr_itable_str_hash32(s) | ((uint64_t)s->len << 32));
}

static inline ScrITableSegment *scr_itable_segment(ScrITable *t, uint64_t hash) {
  return &t->segments[hash >> (64 - SCR_ITABLE_SEGMENT_BITS)];
}

static inline uint64_t scr_itable_tag(uint64_t hash) {
  return ((hash >> 50) & 0xff) << SCR_ITABLE_TAG_SHIFT;
}

static inline const ScrITableStrEntry *scr_itable_slot_entry(uint64_t slot) {
  return (const ScrITableStrEntry *)(uintptr_t)(slot & ~SCR_ITABLE_TAG_MASK);
}

/* ── lookups ─────────────────────────────────────────────────────────── */

static const ScrITableStrEntry *scr_itable_probe_str(const ScrITableIndex *index, uint64_t hash,
                                                     const ScrStr *key) {
  if (!index) return NULL;
  uint64_t tag = scr_itable_tag(hash);
  for (uint64_t i = hash & index->mask;; i = (i + 1) & index->mask) {
    uint64_t slot = atomic_load_explicit(&index->words[i], memory_order_acquire);
    if (slot == 0) return NULL;
    if ((slot & SCR_ITABLE_TAG_MASK) != tag) continue;
    const ScrITableStrEntry *e = scr_itable_slot_entry(slot);
    if (e->hash == hash && e->len == key->len && scr_key_equal(e->data, key->data, key->len)) return e;
  }
}

/* The { value, key } pair of a stored number key, or NULL. */
static _Atomic uint64_t *scr_itable_probe_f64(ScrITableIndex *index, uint64_t hash, uint64_t stored) {
  if (!index) return NULL;
  for (uint64_t i = hash & index->mask;; i = (i + 1) & index->mask) {
    uint64_t key = atomic_load_explicit(&index->words[2 * i + 1], memory_order_acquire);
    if (key == stored) return &index->words[2 * i];
    if (key == 0) return NULL;
  }
}

const ScrITableEntry *scr_itable_find_str(ScrITable *t, const ScrStr *key) {
  uint64_t hash = scr_itable_str_hash(key);
  ScrITableSegment *seg = scr_itable_segment(t, hash);
  return (const ScrITableEntry *)scr_itable_probe_str(
      atomic_load_explicit(&seg->index, memory_order_acquire), hash, key);
}

const ScrITableEntry *scr_itable_find_f64(ScrITable *t, double key) {
  uint64_t stored = scr_itable_f64_bits(key) ^ SCR_ITABLE_F64_FLIP;
  uint64_t hash = scr_itable_f64_hash(stored);
  ScrITableSegment *seg = scr_itable_segment(t, hash);
  return (const ScrITableEntry *)scr_itable_probe_f64(
      atomic_load_explicit(&seg->index, memory_order_acquire), hash, stored);
}

/* ── inserts (the segment lock held) ─────────────────────────────────── */

static ScrITableIndex *scr_itable_index_new(uint64_t slots, unsigned words) {
  ScrITableIndex *index = calloc(1, sizeof(ScrITableIndex) + slots * words * sizeof(uint64_t));
  if (!index) scr_itable_oom();
  index->mask = slots - 1;
  return index;
}

/* Makes room for one more key: the segment's index, created or grown so
 * that it stays at most half full. Growth rehashes every stored key. */
static ScrITableIndex *scr_itable_reserve(ScrITableSegment *seg, bool numbers) {
  ScrITableIndex *index = atomic_load_explicit(&seg->index, memory_order_relaxed);
  uint64_t count = atomic_load_explicit(&seg->count, memory_order_relaxed);
  unsigned words = numbers ? 2 : 1;
  if (index && (count + 1) * 2 <= index->mask + 1) return index;
  ScrITableIndex *grown = scr_itable_index_new(index ? (index->mask + 1) * 2 : SCR_ITABLE_FIRST_SLOTS, words);
  if (index) {
    for (uint64_t i = 0; i <= index->mask; i++) {
      uint64_t last = atomic_load_explicit(&index->words[i * words + words - 1], memory_order_relaxed);
      if (last == 0) continue;
      uint64_t hash = numbers ? scr_itable_f64_hash(last) : scr_itable_slot_entry(last)->hash;
      uint64_t j = hash & grown->mask;
      while (atomic_load_explicit(&grown->words[j * words + words - 1], memory_order_relaxed) != 0)
        j = (j + 1) & grown->mask;
      if (numbers)
        atomic_store_explicit(&grown->words[2 * j],
                              atomic_load_explicit(&index->words[2 * i], memory_order_relaxed),
                              memory_order_relaxed);
      atomic_store_explicit(&grown->words[j * words + words - 1], last, memory_order_relaxed);
    }
    grown->retired = index;
  }
  atomic_store_explicit(&seg->index, grown, memory_order_release);
  return grown;
}

/* The first empty slot of the key's probe (the key is known to be absent). */
static uint64_t scr_itable_free_slot(const ScrITableIndex *index, uint64_t hash, unsigned words) {
  uint64_t i = hash & index->mask;
  while (atomic_load_explicit(&index->words[i * words + words - 1], memory_order_relaxed) != 0)
    i = (i + 1) & index->mask;
  return i;
}

static void scr_itable_counted(ScrITableSegment *seg) {
  atomic_store_explicit(&seg->count, atomic_load_explicit(&seg->count, memory_order_relaxed) + 1,
                        memory_order_relaxed);
}

static void *scr_itable_alloc(ScrITableSegment *seg, size_t size) {
  size = (size + 7) & ~(size_t)7;
  ScrITableChunk *chunk = seg->chunks;
  if (!chunk || chunk->size - chunk->used < size) {
    size_t next = chunk ? chunk->size * 2 : SCR_ITABLE_FIRST_CHUNK;
    if (next > SCR_ITABLE_MAX_CHUNK) next = SCR_ITABLE_MAX_CHUNK;
    if (next < size) next = size;
    chunk = calloc(1, sizeof(ScrITableChunk) + next);
    if (!chunk) scr_itable_oom();
    if ((uint64_t)(uintptr_t)chunk & SCR_ITABLE_TAG_MASK)
      scr_trap("scriptc: InternTable memory is outside the supported address range\n");
    chunk->size = next;
    chunk->next = seg->chunks;
    seg->chunks = chunk;
  }
  void *p = chunk->data + chunk->used;
  chunk->used += size;
  return p;
}

const ScrITableEntry *scr_itable_insert_str(ScrITable *t, const ScrStr *key, uint64_t value) {
  if (key->len > UINT32_MAX) scr_trap("scriptc: InternTable key is too long\n");
  uint64_t hash = scr_itable_str_hash(key);
  ScrITableSegment *seg = scr_itable_segment(t, hash);
  scr_itable_lock(&seg->lock);
  const ScrITableStrEntry *found =
      scr_itable_probe_str(atomic_load_explicit(&seg->index, memory_order_relaxed), hash, key);
  if (!found) {
    ScrITableIndex *index = scr_itable_reserve(seg, false);
    ScrITableStrEntry *entry = scr_itable_alloc(seg, sizeof(ScrITableStrEntry) + key->len);
    entry->value = value;
    entry->hash = hash;
    entry->len = (uint32_t)key->len;
    memcpy(entry->data, key->data, key->len);
    uint64_t i = scr_itable_free_slot(index, hash, 1);
    atomic_store_explicit(&index->words[i], (uint64_t)(uintptr_t)entry | scr_itable_tag(hash),
                          memory_order_release);
    scr_itable_counted(seg);
    found = entry;
  }
  scr_itable_unlock(&seg->lock);
  return (const ScrITableEntry *)found;
}

const ScrITableEntry *scr_itable_insert_f64(ScrITable *t, double key, uint64_t value) {
  uint64_t stored = scr_itable_f64_bits(key) ^ SCR_ITABLE_F64_FLIP;
  uint64_t hash = scr_itable_f64_hash(stored);
  ScrITableSegment *seg = scr_itable_segment(t, hash);
  scr_itable_lock(&seg->lock);
  _Atomic uint64_t *found =
      scr_itable_probe_f64(atomic_load_explicit(&seg->index, memory_order_relaxed), hash, stored);
  if (!found) {
    ScrITableIndex *index = scr_itable_reserve(seg, true);
    uint64_t i = scr_itable_free_slot(index, hash, 2);
    atomic_store_explicit(&index->words[2 * i], value, memory_order_relaxed);
    atomic_store_explicit(&index->words[2 * i + 1], stored, memory_order_release);
    scr_itable_counted(seg);
    found = &index->words[2 * i];
  }
  scr_itable_unlock(&seg->lock);
  return (const ScrITableEntry *)found;
}

double scr_itable_size(const ScrITable *t) {
  uint64_t total = 0;
  for (unsigned i = 0; i < SCR_ITABLE_SEGMENTS; i++)
    total += atomic_load_explicit(&t->segments[i].count, memory_order_relaxed);
  return (double)total;
}

/* ── the registry ────────────────────────────────────────────────────── */

static atomic_uint scr_itable_registry_lock;
static ScrITable *scr_itable_registry;

ScrITable *scr_itable_open(const ScrStr *name, int key_kind) {
  scr_itable_lock(&scr_itable_registry_lock);
  ScrITable *t = scr_itable_registry;
  while (t && !(t->name_len == name->len && memcmp(t->name, name->data, name->len) == 0)) t = t->next;
  if (!t) {
    /* Segments are cache-line aligned; tables are never freed, so the
     * block's start need not be kept. */
    char *block = calloc(1, sizeof(ScrITable) + name->len + 63);
    if (!block) scr_itable_oom();
    t = (ScrITable *)(((uintptr_t)block + 63) & ~(uintptr_t)63);
    t->key_kind = key_kind;
    t->name_len = name->len;
    memcpy(t->name, name->data, name->len);
    t->next = scr_itable_registry;
    scr_itable_registry = t;
  }
  scr_itable_unlock(&scr_itable_registry_lock);
  if (t->key_kind != key_kind) scr_trap("scriptc: an InternTable name is open with another key type\n");
  return t;
}

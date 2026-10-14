/* Counted lifetime regions (@scriptc/experimental LifetimeRegion): the
 * allocator, the region table and the release check for ProgramLifetime
 * instances. The emitted half (llvm/regions.ts) inlines the allocation fast
 * path and the count updates, and supplies the per-class visits and the
 * walkers of ordinary classes and records; the contract is in
 * scr_runtime.h.
 *
 * Threads. Every script thread owns its regions, its cursors and its
 * default region; region ids are process-wide and never reused, so a region
 * handle that reaches another thread (or outlives its region) selects that
 * thread's default region and releases nothing. Chunks record their owner:
 * worker executables count only references to their own chunks, so a
 * published instance that other threads read is never counted by them.
 * Publication makes an instance immortal (rc == SIZE_MAX); the release walk
 * sees that and pins the region, which is then never freed.
 *
 * Counting. The default regions are never freed, so references to their
 * objects are not counted (their chunks have no owner), and until the first
 * region exists nothing is counted at all (scr_region_counting): a program
 * that supports regions pays for counts only once it uses one.
 *
 * The release check. A walk visits every instance of the region (each
 * class's visit reports its reference fields) and, from there, every
 * ordinary object it can explain: classes and records through the emitted
 * walkers, and the runtime's own containers (arrays, maps and sets, unions,
 * closures and their capture boxes, dyn values) through the release entry
 * points they store for their elements. Each ordinary object reached is an
 * entry: the references the walk found to it, the references it holds into
 * the region, and the entries it references. An entry whose count exceeds
 * the references found is referenced from outside, and so is everything it
 * reaches. The region is freed when the references found from its own
 * objects and from the entries nothing outside references add up to its
 * counted references. Anything the walk cannot see only leaves references
 * unexplained: mistakes keep memory, they never free it.
 *
 * Sanitized builds (the RC audit lane, AddressSanitizer) never reuse a
 * freed chunk: it stays mapped without access, so any use after free
 * faults. SCRIPTC_REGION_STATS=1 reports every release attempt on stderr. */

#include "scr_runtime.h"

#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#if defined(_WIN32)
#include <malloc.h>
#define SCR_RGN_MMAP 0
#elif defined(__wasi__) || defined(__wasm__)
#define SCR_RGN_MMAP 0
#else
#include <sys/mman.h>
#define SCR_RGN_MMAP 1
#endif

#if defined(SCR_RC_AUDIT) || defined(SCR_LSAN_IMMORTAL)
#define SCR_RGN_POISON 1
#endif
#ifdef SCR_LSAN_IMMORTAL
/* Chunks are not heap blocks: register them as leak-scan roots so what
 * their instances hold is reachable, like the published-object roots. */
void __lsan_register_root_region(const void *p, size_t size) __attribute__((weak));
void __lsan_unregister_root_region(const void *p, size_t size) __attribute__((weak));
#endif

#define SCR_RGN_HDR ((size_t)64)
#define SCR_RGN_SEG ((size_t)16384)
#define SCR_RGN_AHEAD ((size_t)256 << 10)      /* see scr_rgn_ahead */
#define SCR_RGN_AHEAD_START ((size_t)1 << 20)  /* see scr_rgn_ahead */
_Static_assert(sizeof(ScrRgnChunk) <= SCR_RGN_HDR, "the chunk header fits before the first segment");

/* Regions start with small pages and switch to huge pages once they span
 * this many chunks (a default region at once): small regions then do not
 * pay a 2 MiB fault, large ones do not pay 512 small ones. */
#define SCR_RGN_HUGE_AFTER 4

/* Pressure retries: a thread that has condemned regions retries them at a
 * region entry once it has allocated this many bytes (or the condemned
 * size, if larger) since the last attempt, doubling after each attempt
 * that freed nothing. */
#define SCR_RGN_RETRY_BYTES ((size_t)8 << 20)
#define SCR_RGN_MAX_BACKOFF 6

enum { SCR_RGN_LIVE = 1, SCR_RGN_CONDEMNED, SCR_RGN_PINNED, SCR_RGN_LEAKED };

typedef struct ScrRgnSeg {
  char *start, *end, *limit; /* instances of one class at its stride */
  const ScrRgnClass *cls;
  struct ScrRgnSeg *next;
} ScrRgnSeg;

typedef struct ScrRegion {
  uint64_t id; /* 0: the thread's default region */
  int state;
  uint32_t depth; /* run() frames active on this region */
  ScrRgnChunk *chunks;
  size_t nchunks;
  ScrRgnSeg *segs;
  ScrRgnSeg **cur; /* per class slot: the segment allocations continue in */
  size_t ncur;
  size_t bytes;
  ScrRgnChunk *spare; /* the next chunk, mapped and faulted in ahead of use */
} ScrRegion;

typedef struct {
  ScrRegion *prev, *entered;
} ScrRgnFrame;

/* The release walk's per-thread state (buffers are reused across walks). */
typedef struct {
  void *obj;
  int64_t found; /* references to it the walk saw */
  int64_t rrefs; /* references it holds into the region */
  bool black;    /* referenced from outside, or reached from such an entry */
} ScrRgnEntry;

typedef struct {
  size_t parent, child;
} ScrRgnEdge;

enum {
  SCR_RGN_W_EMITTED,
  SCR_RGN_W_ARR,
  SCR_RGN_W_MAP,
  SCR_RGN_W_UNION,
  SCR_RGN_W_CLOSURE,
  SCR_RGN_W_BOX,
  SCR_RGN_W_DYN,
};

typedef struct {
  size_t entry;
  int kind;
  void (*walk)(void *, ScrRgnWalk *);
} ScrRgnWork;

struct ScrRgnWalk {
  ScrRegion *region;
  int64_t internal; /* references found from the region's own objects */
  size_t src;       /* entry index + 1 being walked; 0 = a region object */
  ScrRgnEntry *ents;
  size_t nents, cap_ents;
  size_t *hash; /* open addressing: entry index + 1 */
  size_t cap_hash;
  ScrRgnEdge *edges;
  size_t nedges, cap_edges;
  ScrRgnWork *work;
  size_t nwork, cap_work;
};

typedef struct {
  ScrRegion *current, *dflt;
  ScrRgnCursor **cursors; /* per class slot; NULL until this thread allocates it */
  size_t ncursors;
  ScrRegion **regions; /* every non-default region this thread owns and has not freed */
  size_t nregions, cap_regions;
  ScrRgnFrame *stack;
  size_t depth, cap_stack;
  size_t since_attempt;
  unsigned backoff;
  ScrRgnWalk walk;
  bool exit_registered;
  double cycle_ms; /* the cycle pass before the next attempt (stats) */
  struct {
    size_t created, released, freed, pinned, leaked, attempts;
  } stats;
} ScrRgnThread;

static SCR_TL ScrRgnThread scr_rgn;

static _Atomic(uint64_t) scr_rgn_next_id = 1;
static _Atomic(int32_t) scr_rgn_next_slot = 0;
static _Atomic(const ScrRgnType *) scr_rgn_types = NULL;
static _Atomic(int) scr_rgn_stats_mode = -1;

/* The walker index of the emitted type table, by release entry point.
 * Built once, by the first walk; the table itself is constant. */
static _Atomic(int) scr_rgn_index_state = 0; /* 0 none, 1 building, 2 ready */
static const ScrRgnType **scr_rgn_index;
static size_t scr_rgn_index_cap;

static bool scr_rgn_stats(void) {
  int mode = atomic_load_explicit(&scr_rgn_stats_mode, memory_order_relaxed);
  if (mode < 0) {
    const char *env = scr_getenv("SCRIPTC_REGION_STATS");
    mode = env != NULL && env[0] != 0 && strcmp(env, "0") != 0;
    atomic_store_explicit(&scr_rgn_stats_mode, mode, memory_order_relaxed);
  }
  return mode != 0;
}

static void *scr_rgn_grow(void *p, size_t *cap, size_t size, size_t first) {
  size_t n = *cap ? *cap * 2 : first;
  void *q = realloc(p, n * size);
  if (!q) scr_trap("scriptc: out of memory\n");
  *cap = n;
  return q;
}

_Atomic uint8_t scr_region_counting = 0;

/* The owner word of the calling thread's freeable chunks: worker
 * executables compare it with the thread's own &scr_thread_hot. */
static void *scr_rgn_self(void) {
#ifdef SCR_WORKERS
  return &scr_thread_hot;
#else
  return &scr_rgn;
#endif
}

/* ── chunks and segments ─────────────────────────────────────────────── */

static ScrRgnChunk *scr_rgn_chunk_map(void) {
#if SCR_RGN_MMAP
  char *raw = mmap(NULL, 2 * SCR_RGN_CHUNK, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  if (raw == MAP_FAILED) scr_trap("scriptc: out of memory\n");
  uintptr_t base = ((uintptr_t)raw + SCR_RGN_CHUNK - 1) & ~(uintptr_t)(SCR_RGN_CHUNK - 1);
  if (base > (uintptr_t)raw) munmap(raw, base - (uintptr_t)raw);
  uintptr_t end = (uintptr_t)raw + 2 * SCR_RGN_CHUNK;
  if (end > base + SCR_RGN_CHUNK) munmap((void *)(base + SCR_RGN_CHUNK), end - (base + SCR_RGN_CHUNK));
  return (ScrRgnChunk *)base;
#elif defined(_WIN32)
  void *p = _aligned_malloc(SCR_RGN_CHUNK, SCR_RGN_CHUNK);
  if (!p) scr_trap("scriptc: out of memory\n");
  memset(p, 0, SCR_RGN_CHUNK);
  return p;
#else
  void *p = aligned_alloc(SCR_RGN_CHUNK, SCR_RGN_CHUNK);
  if (!p) scr_trap("scriptc: out of memory\n");
  memset(p, 0, SCR_RGN_CHUNK);
  return p;
#endif
}

/* A freed region's chunk. Sanitized builds keep it mapped without access
 * and never hand it out again, so a reference that survived faults. */
static void scr_rgn_chunk_unmap(ScrRgnChunk *c) {
#ifdef SCR_LSAN_IMMORTAL
  if (__lsan_unregister_root_region) __lsan_unregister_root_region(c, SCR_RGN_CHUNK);
#endif
#if SCR_RGN_MMAP
#ifdef SCR_RGN_POISON
  if (mprotect(c, SCR_RGN_CHUNK, PROT_NONE) != 0) scr_trap("scriptc: mprotect failed\n");
#else
  munmap(c, SCR_RGN_CHUNK);
#endif
#elif defined(SCR_RGN_POISON)
  memset(c, 0xdb, SCR_RGN_CHUNK); /* no page protection here: poison, keep */
#elif defined(_WIN32)
  _aligned_free(c);
#else
  free(c);
#endif
}

/* Whether the region's next chunk uses huge pages. */
static bool scr_rgn_huge(const ScrRegion *r) { return r->id == 0 || r->nchunks + 1 >= SCR_RGN_HUGE_AFTER; }

/* A chunk for `r`'s next one, with its page policy. */
static ScrRgnChunk *scr_rgn_chunk_reserve(const ScrRegion *r) {
  ScrRgnChunk *c = scr_rgn_chunk_map();
#if SCR_RGN_MMAP && defined(MADV_HUGEPAGE)
  if (scr_rgn_huge(r)) (void)madvise(c, SCR_RGN_CHUNK, MADV_HUGEPAGE);
#else
  (void)r;
#endif
  return c;
}

static ScrRgnChunk *scr_rgn_chunk_new(ScrRegion *r) {
  ScrRgnChunk *c = r->spare ? r->spare : scr_rgn_chunk_reserve(r);
  r->spare = NULL;
  if (r->bytes >= SCR_RGN_AHEAD_START) scr_mem_prefault(c, (char *)c + 2 * SCR_RGN_AHEAD);
#ifdef SCR_LSAN_IMMORTAL
  if (__lsan_register_root_region) __lsan_register_root_region(c, SCR_RGN_CHUNK);
#endif
  c->count = 0;
  c->owner = r->id == 0 ? NULL : scr_rgn_self(); /* the default region is never counted */
  c->region = r;
  c->next = r->chunks;
  c->bump = (char *)c + SCR_RGN_HDR;
  c->found = 0;
  r->chunks = c;
  r->nchunks++;
  return c;
}

/* Faulting ahead, like the small-object allocator's slices: first touch of
 * a fresh page costs a fault and a page clear on the allocating thread, so
 * the allocator's helper thread faults memory in just ahead of the bump.
 * Nothing is faulted ahead before a region has carved SCR_RGN_AHEAD_START,
 * so small regions commit nothing extra. Then the bump entering an
 * SCR_RGN_AHEAD step requests the next one, a new chunk starts with its
 * first two steps requested, and a chunk that is half carved maps the
 * region's next chunk and has it faulted in (one huge page, or its first
 * step), so a growing region rarely waits for the kernel. */
static void scr_rgn_ahead(ScrRegion *r, ScrRgnChunk *c, char *from) {
  if (r->bytes < SCR_RGN_AHEAD_START) return;
  size_t before = (size_t)(from - (char *)c), after = (size_t)(c->bump - (char *)c);
  if (after / SCR_RGN_AHEAD != before / SCR_RGN_AHEAD) {
    char *lo = (char *)c + (after / SCR_RGN_AHEAD + 1) * SCR_RGN_AHEAD;
    if (lo < (char *)c + SCR_RGN_CHUNK) scr_mem_prefault(lo, lo + SCR_RGN_AHEAD);
  }
  if (!r->spare && after >= SCR_RGN_CHUNK / 2 && before < SCR_RGN_CHUNK / 2) {
    bool huge = scr_rgn_huge(r);
    r->spare = scr_rgn_chunk_reserve(r);
    scr_mem_prefault(r->spare, (char *)r->spare + (huge ? SCR_RGN_CHUNK : SCR_RGN_AHEAD));
  }
}

/* A spare chunk never held objects: it goes straight back. */
static void scr_rgn_spare_drop(ScrRegion *r) {
  if (!r->spare) return;
#if SCR_RGN_MMAP
  munmap(r->spare, SCR_RGN_CHUNK);
#elif defined(_WIN32)
  _aligned_free(r->spare);
#else
  free(r->spare);
#endif
  r->spare = NULL;
}

/* The instance stride: the emitted fast path rounds the size the same way. */
static inline size_t scr_rgn_stride(const ScrRgnClass *cls) { return (cls->size + 7) & ~(size_t)7; }

static ScrRgnSeg *scr_rgn_seg_new(ScrRegion *r, const ScrRgnClass *cls) {
  size_t stride = scr_rgn_stride(cls);
  size_t need = stride > SCR_RGN_SEG ? stride : SCR_RGN_SEG;
  if (need > SCR_RGN_CHUNK - SCR_RGN_HDR) scr_trap("scriptc: ProgramLifetime instance too large for a region\n");
  ScrRgnChunk *c = r->chunks;
  if (!c || (size_t)((char *)c + SCR_RGN_CHUNK - c->bump) < need) c = scr_rgn_chunk_new(r);
  ScrRgnSeg *s = malloc(sizeof *s);
  if (!s) scr_trap("scriptc: out of memory\n");
  s->start = s->end = c->bump;
  s->limit = c->bump + need;
  c->bump += need;
  scr_rgn_ahead(r, c, s->start);
  s->cls = cls;
  s->next = r->segs;
  r->segs = s;
  r->bytes += need;
  scr_rgn.since_attempt += need;
  return s;
}

/* ── the thread's region table ───────────────────────────────────────── */

static ScrRegion *scr_rgn_region_new(uint64_t id) {
  ScrRegion *r = calloc(1, sizeof *r);
  if (!r) scr_trap("scriptc: out of memory\n");
  r->id = id;
  r->state = SCR_RGN_LIVE;
  return r;
}

static void scr_rgn_thread_exit(void);

static ScrRgnThread *scr_rgn_thread(void) {
  ScrRgnThread *t = &scr_rgn;
  if (!t->dflt) {
    t->dflt = scr_rgn_region_new(0);
    t->current = t->dflt;
    if (!t->exit_registered) {
      t->exit_registered = true;
      scr_atexit(scr_rgn_thread_exit);
    }
  }
  return t;
}

static ScrRegion *scr_rgn_lookup(ScrRgnThread *t, double id) {
  if (!(id >= 1)) return NULL;
  for (size_t i = 0; i < t->nregions; i++)
    if ((double)t->regions[i]->id == id) return t->regions[i];
  return NULL;
}

static void scr_rgn_forget(ScrRgnThread *t, ScrRegion *r) {
  for (size_t i = 0; i < t->nregions; i++)
    if (t->regions[i] == r) {
      t->regions[i] = t->regions[--t->nregions];
      return;
    }
}

/* The current region's cursors write their bump pointers back into its
 * segments; then `r`'s segments load into the cursors. */
static void scr_rgn_switch(ScrRgnThread *t, ScrRegion *r) {
  ScrRegion *cur = t->current;
  if (cur == r) return;
  for (size_t i = 0; i < t->ncursors; i++) {
    ScrRgnCursor *c = t->cursors[i];
    if (!c) continue;
    if (c->bump) cur->cur[i]->end = c->bump;
    ScrRgnSeg *s = i < r->ncur ? r->cur[i] : NULL;
    c->bump = s ? s->end : NULL;
    c->limit = s ? s->limit : NULL;
  }
  t->current = r;
}

static int32_t scr_rgn_slot(ScrRgnClass *cls) {
  int32_t slot = atomic_load_explicit((_Atomic(int32_t) *)&cls->slot, memory_order_acquire);
  if (slot >= 0) return slot;
  int32_t fresh = atomic_fetch_add_explicit(&scr_rgn_next_slot, 1, memory_order_relaxed);
  int32_t expected = -1;
  if (atomic_compare_exchange_strong_explicit((_Atomic(int32_t) *)&cls->slot, &expected, fresh,
                                              memory_order_acq_rel, memory_order_acquire))
    return fresh;
  return expected; /* another thread numbered it first; `fresh` stays unused */
}

void *scr_region_alloc(ScrRgnCursor *cursor, ScrRgnClass *cls) {
  ScrRgnThread *t = scr_rgn_thread();
  size_t slot = (size_t)scr_rgn_slot(cls);
  if (slot >= t->ncursors) {
    size_t n = slot + 16;
    t->cursors = realloc(t->cursors, n * sizeof *t->cursors);
    if (!t->cursors) scr_trap("scriptc: out of memory\n");
    for (size_t i = t->ncursors; i < n; i++) t->cursors[i] = NULL;
    t->ncursors = n;
  }
  t->cursors[slot] = cursor;
  ScrRegion *r = t->current;
  if (slot >= r->ncur) {
    size_t n = slot + 16;
    r->cur = realloc(r->cur, n * sizeof *r->cur);
    if (!r->cur) scr_trap("scriptc: out of memory\n");
    for (size_t i = r->ncur; i < n; i++) r->cur[i] = NULL;
    r->ncur = n;
  }
  ScrRgnSeg *s = r->cur[slot];
  if (s && cursor->bump) s->end = cursor->bump;
  size_t stride = scr_rgn_stride(cls);
  if (!s || (size_t)(s->limit - s->end) < stride) {
    s = scr_rgn_seg_new(r, cls);
    r->cur[slot] = s;
  }
  char *o = s->end;
  s->end += stride;
  cursor->bump = s->end;
  cursor->limit = s->limit;
  return o; /* its first reference is implied (scr_rgn_counted) */
}

/* ── the release walk ────────────────────────────────────────────────── */

static size_t scr_rgn_hash_of(const void *p, size_t cap) {
  return (size_t)(((uintptr_t)p >> 3) * 0x9E3779B97F4A7C15ull) & (cap - 1);
}

static size_t scr_rgn_find(ScrRgnWalk *w, const void *p) {
  size_t j = scr_rgn_hash_of(p, w->cap_hash);
  while (w->hash[j] && w->ents[w->hash[j] - 1].obj != p) j = (j + 1) & (w->cap_hash - 1);
  return j;
}

static void scr_rgn_rehash(ScrRgnWalk *w) {
  size_t cap = w->cap_hash ? w->cap_hash * 2 : (size_t)1 << 12;
  free(w->hash);
  w->hash = calloc(cap, sizeof *w->hash);
  if (!w->hash) scr_trap("scriptc: out of memory\n");
  w->cap_hash = cap;
  for (size_t i = 0; i < w->nents; i++) w->hash[scr_rgn_find(w, w->ents[i].obj)] = i + 1;
}

/* One more reference to the ordinary object `p`, from the object being
 * walked; queues `p`'s own walk when it is first reached. */
static void scr_rgn_enter(ScrRgnWalk *w, void *p, int kind, void (*walk)(void *, ScrRgnWalk *)) {
  if (!p || *(size_t *)p == SIZE_MAX) return; /* immortal: never freed, not walked */
  if ((w->nents + 1) * 2 > w->cap_hash) scr_rgn_rehash(w);
  size_t j = scr_rgn_find(w, p);
  size_t idx = w->hash[j];
  if (!idx) {
    if (w->nents == w->cap_ents) w->ents = scr_rgn_grow(w->ents, &w->cap_ents, sizeof *w->ents, 4096);
    w->ents[w->nents] = (ScrRgnEntry){p, 0, 0, false};
    idx = w->hash[j] = ++w->nents;
    if (w->nwork == w->cap_work) w->work = scr_rgn_grow(w->work, &w->cap_work, sizeof *w->work, 4096);
    w->work[w->nwork++] = (ScrRgnWork){idx - 1, kind, walk};
  }
  w->ents[idx - 1].found++;
  if (w->src) {
    if (w->nedges == w->cap_edges) w->edges = scr_rgn_grow(w->edges, &w->cap_edges, sizeof *w->edges, 4096);
    w->edges[w->nedges++] = (ScrRgnEdge){w->src - 1, idx - 1};
  }
}

void scr_region_ref(ScrRgnWalk *w, void *obj) {
  if (!obj) return;
  ScrRgnChunk *c = scr_rgn_chunk_of(obj);
  if (c->region != w->region) return; /* another region's: counted there */
  c->found++;
  if (w->src) w->ents[w->src - 1].rrefs++;
  else w->internal++;
}

static const ScrRgnType *scr_rgn_type_of(void (*release)(void *)) {
  if (atomic_load_explicit(&scr_rgn_index_state, memory_order_acquire) != 2 || !scr_rgn_index_cap) return NULL;
  size_t j = scr_rgn_hash_of((const void *)(uintptr_t)release, scr_rgn_index_cap);
  while (scr_rgn_index[j]) {
    if (scr_rgn_index[j]->release == release) return scr_rgn_index[j];
    j = (j + 1) & (scr_rgn_index_cap - 1);
  }
  return NULL;
}

static void scr_rgn_index_build(void) {
  int state = 0;
  if (!atomic_compare_exchange_strong(&scr_rgn_index_state, &state, 1)) {
    while (atomic_load_explicit(&scr_rgn_index_state, memory_order_acquire) != 2) {
    }
    return;
  }
  const ScrRgnType *types = atomic_load_explicit(&scr_rgn_types, memory_order_acquire);
  size_t n = 0;
  for (const ScrRgnType *ty = types; ty && ty->release; ty++) n++;
  size_t cap = 16;
  while (cap < n * 2) cap *= 2;
  scr_rgn_index = calloc(cap, sizeof *scr_rgn_index);
  if (!scr_rgn_index) scr_trap("scriptc: out of memory\n");
  scr_rgn_index_cap = cap;
  for (const ScrRgnType *ty = types; ty && ty->release; ty++) {
    size_t j = scr_rgn_hash_of((const void *)(uintptr_t)ty->release, cap);
    while (scr_rgn_index[j] && scr_rgn_index[j]->release != ty->release) j = (j + 1) & (cap - 1);
    scr_rgn_index[j] = ty;
  }
  atomic_store_explicit(&scr_rgn_index_state, 2, memory_order_release);
}

void scr_region_slot(ScrRgnWalk *w, void *obj, void (*release)(void *)) {
  if (!obj || !release) return;
  if (release == scr_arr_release_v) scr_rgn_enter(w, obj, SCR_RGN_W_ARR, NULL);
  else if (release == scr_map_release_v) scr_rgn_enter(w, obj, SCR_RGN_W_MAP, NULL);
  else if (release == scr_union_release_v) scr_rgn_enter(w, obj, SCR_RGN_W_UNION, NULL);
  else if (release == scr_closure_release_v) scr_rgn_enter(w, obj, SCR_RGN_W_CLOSURE, NULL);
  else if (release == scr_dyn_release_v) scr_rgn_enter(w, obj, SCR_RGN_W_DYN, NULL);
  else {
    const ScrRgnType *ty = scr_rgn_type_of(release);
    if (!ty) return; /* not walkable: its references stay unexplained */
    if (!ty->walk) scr_region_ref(w, obj);
    else scr_rgn_enter(w, obj, SCR_RGN_W_EMITTED, ty->walk);
  }
}

static void *scr_rgn_slot_ptr(uint64_t slot) {
  void *p;
  memcpy(&p, &slot, sizeof p);
  return p;
}

static void scr_rgn_walk_elem(ScrRgnWalk *w, const ScrArr *a, uint64_t slot) {
  if (a->elem == SCR_ELEM_REF) scr_region_slot(w, scr_rgn_slot_ptr(slot), a->ops ? a->ops->release : NULL);
  else if (a->elem == SCR_ELEM_ARR) scr_rgn_enter(w, scr_rgn_slot_ptr(slot), SCR_RGN_W_ARR, NULL);
}

static void scr_rgn_walk_arr(ScrRgnWalk *w, ScrArr *a) {
  if (a->elem != SCR_ELEM_REF && a->elem != SCR_ELEM_ARR) return;
  size_t dense = a->len < a->cap ? a->len : a->cap;
  for (size_t i = 0; i < dense; i++)
    if (!a->present || a->present[i] == SCR_ARR_VALUE) scr_rgn_walk_elem(w, a, a->data[i]);
  if (!a->ext) return;
  for (size_t i = 0; i < a->ext->sparse_len; i++)
    if (a->ext->sparse[i].state == SCR_ARR_VALUE) scr_rgn_walk_elem(w, a, a->ext->sparse[i].slot);
  for (size_t i = 0; i < a->ext->prop_len; i++)
    if (a->ext->props[i].state == SCR_ARR_VALUE) scr_rgn_walk_elem(w, a, a->ext->props[i].slot);
  scr_rgn_enter(w, a->ext->metadata, SCR_RGN_W_DYN, NULL);
}

static void scr_rgn_walk_map(ScrRgnWalk *w, ScrMap *m) {
  bool keyref = m->key_kind == SCR_MAP_KEY_REF || m->key_kind == SCR_MAP_KEY_UNION_REF ||
      m->key_kind == SCR_MAP_KEY_UNION_VALUE;
  bool keydyn = m->key_kind == SCR_MAP_KEY_DYN;
  bool valref = m->val_kind == SCR_MAP_VAL_REF;
  if (!keyref && !keydyn && !valref) return;
  for (size_t i = 0; i < m->nentries; i++) {
    const ScrMapEntry *e = &m->entries[i];
    if (!e->hash) continue; /* tombstone */
    if (keyref) scr_region_slot(w, scr_rgn_slot_ptr(e->key), m->key_release);
    else if (keydyn) scr_rgn_enter(w, scr_rgn_slot_ptr(e->key), SCR_RGN_W_DYN, NULL);
    if (valref) scr_region_slot(w, scr_rgn_slot_ptr(e->val), m->val_release);
  }
}

static void scr_rgn_walk_box(ScrRgnWalk *w, ScrBox *b) {
  void *p = scr_rgn_slot_ptr(b->slot);
  switch (b->kind) {
  case SCR_BOX_OBJ: scr_region_slot(w, p, b->obj_release); break;
  case SCR_BOX_ARR: scr_rgn_enter(w, p, SCR_RGN_W_ARR, NULL); break;
  case SCR_BOX_FUNC: scr_rgn_enter(w, p, SCR_RGN_W_CLOSURE, NULL); break;
  default: break; /* strings and scalars hold no references */
  }
}

static void scr_rgn_walk_closure(ScrRgnWalk *w, ScrClosure *c) {
  for (size_t i = 0; i < c->ncaps; i++) scr_rgn_enter(w, c->caps[i], SCR_RGN_W_BOX, NULL);
  scr_rgn_enter(w, c->props, SCR_RGN_W_BOX, NULL);
}

static void scr_rgn_walk_dyn(ScrRgnWalk *w, ScrDyn *d) {
  switch (d->kind) {
  case SCR_DYN_ARR:
    for (size_t i = 0; i < d->v.arr.len; i++)
      if (!d->v.arr.presence || d->v.arr.presence[i]) scr_rgn_enter(w, d->v.arr.items[i], SCR_RGN_W_DYN, NULL);
    scr_rgn_enter(w, d->v.arr.properties, SCR_RGN_W_DYN, NULL);
    break;
  case SCR_DYN_OBJ:
    /* source_identity is owned through its access callback: not walked. */
    for (size_t i = 0; i < d->v.obj.len; i++) {
      const ScrDynEntry *e = &d->v.obj.entries[i];
      if (e->accessor) {
        scr_rgn_enter(w, e->getter, SCR_RGN_W_DYN, NULL);
        scr_rgn_enter(w, e->setter, SCR_RGN_W_DYN, NULL);
      } else scr_rgn_enter(w, e->value, SCR_RGN_W_DYN, NULL);
    }
    break;
  case SCR_DYN_FUNC: scr_rgn_enter(w, d->v.fn.clo, SCR_RGN_W_CLOSURE, NULL); break;
  case SCR_DYN_TYPED_REF:
    scr_region_slot(w, d->v.typed_ref.ptr, d->v.typed_ref.release);
    scr_rgn_enter(w, d->v.typed_ref.materialized, SCR_RGN_W_DYN, NULL);
    for (ScrDynTypedCast *cast = d->v.typed_ref.casts; cast; cast = cast->next)
      scr_region_slot(w, cast->ptr, cast->release);
    break;
  case SCR_DYN_PROXY:
    scr_rgn_enter(w, d->v.proxy.target, SCR_RGN_W_DYN, NULL);
    scr_rgn_enter(w, d->v.proxy.handler, SCR_RGN_W_DYN, NULL);
    break;
  default: break; /* scalars, strings, bytes; handles and promises are not walked */
  }
  scr_rgn_enter(w, d->prototype, SCR_RGN_W_DYN, NULL);
  scr_rgn_enter(w, d->symbol_properties, SCR_RGN_W_DYN, NULL);
  scr_rgn_enter(w, d->symbol_keys, SCR_RGN_W_DYN, NULL);
}

static void scr_rgn_drain(ScrRgnWalk *w) {
  while (w->nwork) {
    ScrRgnWork job = w->work[--w->nwork];
    void *p = w->ents[job.entry].obj;
    w->src = job.entry + 1;
    switch (job.kind) {
    case SCR_RGN_W_EMITTED: job.walk(p, w); break;
    case SCR_RGN_W_ARR: scr_rgn_walk_arr(w, p); break;
    case SCR_RGN_W_MAP: scr_rgn_walk_map(w, p); break;
    case SCR_RGN_W_UNION: {
      ScrUnion *u = p;
      if (u->arm_release) scr_region_slot(w, scr_rgn_slot_ptr(u->slot), u->arm_release);
      break;
    }
    case SCR_RGN_W_CLOSURE: scr_rgn_walk_closure(w, p); break;
    case SCR_RGN_W_BOX: scr_rgn_walk_box(w, p); break;
    case SCR_RGN_W_DYN: scr_rgn_walk_dyn(w, p); break;
    }
  }
  w->src = 0;
}

/* Trial deletion over the entries: marks the ones referenced from outside
 * and everything they reach, and returns the references into the region
 * held by the rest. */
static int64_t scr_rgn_settle(ScrRgnWalk *w, size_t *black_out) {
  size_t n = w->nents;
  size_t *start = calloc(n + 1, sizeof *start);
  size_t *child = malloc((w->nedges + 1) * sizeof *child);
  size_t *stack = malloc((n + 1) * sizeof *stack);
  if (!start || !child || !stack) scr_trap("scriptc: out of memory\n");
  for (size_t e = 0; e < w->nedges; e++) start[w->edges[e].parent + 1]++;
  for (size_t i = 0; i < n; i++) start[i + 1] += start[i];
  for (size_t e = 0; e < w->nedges; e++) child[start[w->edges[e].parent]++] = w->edges[e].child;
  for (size_t i = n; i > 0; i--) start[i] = start[i - 1]; /* the fill moved each start to its end */
  start[0] = 0;
  size_t top = 0;
  for (size_t i = 0; i < n; i++) {
    ScrRgnEntry *x = &w->ents[i];
    if (*(size_t *)x->obj != (size_t)x->found) {
      x->black = true;
      stack[top++] = i;
    }
  }
  while (top) {
    size_t i = stack[--top];
    for (size_t k = start[i]; k < start[i + 1]; k++) {
      ScrRgnEntry *c = &w->ents[child[k]];
      if (c->black) continue;
      c->black = true;
      stack[top++] = child[k];
    }
  }
  int64_t sum = 0;
  size_t black = 0;
  for (size_t i = 0; i < n; i++) {
    if (w->ents[i].black) black++;
    else sum += w->ents[i].rrefs;
  }
  free(start);
  free(child);
  free(stack);
  *black_out = black;
  return sum;
}

/* The references counted to the region's objects: the chunk counts, plus
 * the first reference every object starts with (allocation counts nothing,
 * so a chunk count can be negative). */
static int64_t scr_rgn_counted(const ScrRegion *r) {
  int64_t n = 0;
  for (const ScrRgnChunk *c = r->chunks; c; c = c->next) n += c->count;
  for (const ScrRgnSeg *s = r->segs; s; s = s->next) n += (int64_t)((size_t)(s->end - s->start) / scr_rgn_stride(s->cls));
  return n;
}

static double scr_rgn_ms(uint64_t from, uint64_t to) { return (double)(to - from) / 1e6; }

/* The region's segments hold instances up to their `end`; a region that
 * is not current has every cursor written back (scr_rgn_switch). */
#define SCR_RGN_EACH(r, s, o) \
  for (ScrRgnSeg *s = (r)->segs; s; s = s->next) \
    for (char *o = s->start; o < s->end; o += scr_rgn_stride(s->cls))

static void scr_rgn_free_region(ScrRgnThread *t, ScrRegion *r) {
  scr_rgn_spare_drop(r);
  for (ScrRgnChunk *c = r->chunks, *next; c; c = next) {
    next = c->next;
    scr_rgn_chunk_unmap(c);
  }
  for (ScrRgnSeg *s = r->segs, *next; s; s = next) {
    next = s->next;
    free(s);
  }
  free(r->cur);
  scr_rgn_forget(t, r);
  free(r);
}

/* One release attempt; true when `r` was freed. */
static bool scr_rgn_try_free(ScrRgnThread *t, ScrRegion *r) {
  bool stats = scr_rgn_stats();
  uint64_t t0 = stats ? scr_hrtime_ns() : 0;
  double cycles = t->cycle_ms;
  t->cycle_ms = 0;
  t->stats.attempts++;
  ScrRgnWalk *w = &t->walk;
  w->region = r;
  w->internal = 0;
  w->src = 0;
  w->nents = w->nedges = w->nwork = 0;
  if (w->hash) memset(w->hash, 0, w->cap_hash * sizeof *w->hash);
  for (ScrRgnChunk *c = r->chunks; c; c = c->next) c->found = 0;
  size_t objects = 0;
  SCR_RGN_EACH(r, s, o) {
    if (*(size_t *)o == SIZE_MAX) {
      /* Published: other threads may hold it, uncounted. */
      r->state = SCR_RGN_PINNED;
      t->stats.pinned++;
      if (stats) fprintf(stderr, "scriptc region %llu: pinned: it holds a published object\n", (unsigned long long)r->id);
      return false;
    }
    s->cls->visit(o, w);
    objects++;
  }
  scr_rgn_drain(w);
  int64_t counted = scr_rgn_counted(r);
  size_t black = 0;
  int64_t explained = w->internal + scr_rgn_settle(w, &black);
  uint64_t t1 = stats ? scr_hrtime_ns() : 0;
  if (explained != counted) {
    if (stats)
      fprintf(stderr,
              "scriptc region %llu: kept: %lld references counted, %lld explained; %zu of %zu owned objects referenced from outside; cycles %.1f ms, walk %.1f ms\n",
              (unsigned long long)r->id, (long long)counted, (long long)explained, black, w->nents, cycles, scr_rgn_ms(t0, t1));
    return false;
  }
  /* Free: drop weak entries keyed by the instances, then release every
   * reference field. The owned objects tear down through their own
   * releases; the cycle collector frees the owned cycles. */
  if (scr_weak_dispose_hook) SCR_RGN_EACH(r, s, o) scr_weak_dispose(o);
  SCR_RGN_EACH(r, s, o) s->cls->release_fields(o);
  int64_t left = scr_rgn_counted(r);
  if (left != 0) {
    scr_collect_cycles();
    left = scr_rgn_counted(r);
  }
  if (left != 0) {
    /* The walk explained references that do not exist: the instances are
     * already released, so keep their memory forever. */
    r->state = SCR_RGN_LEAKED;
    t->stats.leaked++;
    fprintf(stderr, "scriptc region %llu: %lld references left after release; memory kept\n",
            (unsigned long long)r->id, (long long)left);
#ifdef SCR_RC_AUDIT
    abort();
#endif
    return false;
  }
#ifdef SCR_RC_AUDIT
  scr_obj_lifetime_forget((long)objects);
#endif
  size_t bytes = r->nchunks * SCR_RGN_CHUNK, nchunks = r->nchunks;
  uint64_t id = r->id;
  scr_rgn_free_region(t, r);
  t->stats.freed++;
  if (stats)
    fprintf(stderr,
            "scriptc region %llu: freed %zu objects, %zu owned objects, %zu chunks (%.1f MiB); cycles %.1f ms, walk %.1f ms, free %.1f ms\n",
            (unsigned long long)id, objects, w->nents, nchunks, (double)bytes / 1048576.0, cycles, scr_rgn_ms(t0, t1),
            scr_rgn_ms(t1, scr_hrtime_ns()));
  return true;
}

static bool scr_rgn_due(const ScrRegion *r, const ScrRgnThread *t) {
  return r->state == SCR_RGN_CONDEMNED && r->depth == 0 && r != t->current;
}

/* Tries every condemned region that is not in use. */
static void scr_rgn_retry(ScrRgnThread *t) {
  bool any = false;
  for (size_t i = 0; i < t->nregions && !any; i++) any = scr_rgn_due(t->regions[i], t);
  t->since_attempt = 0;
  if (!any) return;
  if (atomic_load_explicit(&scr_rgn_index_state, memory_order_acquire) != 2) scr_rgn_index_build();
  /* Dead cycles of ordinary objects can hold counted references into a
   * condemned region until the collector frees them. */
  uint64_t t0 = scr_rgn_stats() ? scr_hrtime_ns() : 0;
  scr_collect_cycles();
  if (t0) t->cycle_ms = scr_rgn_ms(t0, scr_hrtime_ns());
  bool freed = false;
  for (size_t i = 0; i < t->nregions;) {
    ScrRegion *r = t->regions[i];
    if (scr_rgn_due(r, t) && scr_rgn_try_free(t, r)) {
      freed = true;
      i = 0; /* the table shrank; freeing may have unblocked another region */
      continue;
    }
    i++;
  }
  if (freed) t->backoff = 0;
  else if (t->backoff < SCR_RGN_MAX_BACKOFF) t->backoff++;
}

/* ── program-facing entry points ─────────────────────────────────────── */

double scr_region_create(const ScrRgnType *types) {
  const ScrRgnType *expected = NULL;
  atomic_compare_exchange_strong(&scr_rgn_types, &expected, types);
  /* Counting starts before the region's first object exists. */
  atomic_store_explicit(&scr_region_counting, 1, memory_order_relaxed);
  ScrRgnThread *t = scr_rgn_thread();
  scr_rgn_retry(t);
  uint64_t id = atomic_fetch_add_explicit(&scr_rgn_next_id, 1, memory_order_relaxed);
  if (t->nregions == t->cap_regions) t->regions = scr_rgn_grow(t->regions, &t->cap_regions, sizeof *t->regions, 16);
  t->regions[t->nregions++] = scr_rgn_region_new(id);
  t->stats.created++;
  return (double)id;
}

void scr_region_enter(double id) {
  ScrRgnThread *t = scr_rgn_thread();
  ScrRegion *r = scr_rgn_lookup(t, id);
  if (!r || r->state != SCR_RGN_LIVE) r = t->dflt; /* released regions take no new objects */
  if (t->nregions && t->since_attempt >= (SCR_RGN_RETRY_BYTES << t->backoff)) scr_rgn_retry(t);
  if (t->depth == t->cap_stack) t->stack = scr_rgn_grow(t->stack, &t->cap_stack, sizeof *t->stack, 16);
  t->stack[t->depth++] = (ScrRgnFrame){t->current, r};
  r->depth++;
  scr_rgn_switch(t, r);
}

void scr_region_leave(void) {
  ScrRgnThread *t = &scr_rgn;
  if (t->depth == 0) scr_trap("scriptc: internal error: unbalanced region leave\n");
  ScrRgnFrame f = t->stack[--t->depth];
  f.entered->depth--;
  scr_rgn_switch(t, f.prev);
}

void scr_region_release(double id) {
  ScrRgnThread *t = scr_rgn_thread();
  ScrRegion *r = scr_rgn_lookup(t, id);
  if (!r || r->state != SCR_RGN_LIVE) return;
  r->state = SCR_RGN_CONDEMNED;
  t->stats.released++;
  scr_rgn_retry(t);
}

/* Thread (or process) exit: the regions can no longer be released, but
 * their instances may be published, so the chunks stay; the bookkeeping
 * goes. */
static void scr_rgn_thread_exit(void) {
  ScrRgnThread *t = &scr_rgn;
  if (scr_rgn_stats()) {
    size_t condemned = 0;
    for (size_t i = 0; i < t->nregions; i++) condemned += t->regions[i]->state == SCR_RGN_CONDEMNED;
    fprintf(stderr, "scriptc regions: %zu created, %zu released, %zu freed, %zu pinned, %zu kept\n",
            t->stats.created, t->stats.released, t->stats.freed, t->stats.pinned, condemned);
  }
  ScrRegion *all[1] = {t->dflt};
  for (size_t i = 0; i <= t->nregions; i++) {
    ScrRegion *r = i < t->nregions ? t->regions[i] : all[0];
    if (!r) continue;
    scr_rgn_spare_drop(r);
    for (ScrRgnSeg *s = r->segs, *next; s; s = next) {
      next = s->next;
      free(s);
    }
    free(r->cur);
    free(r);
  }
  free(t->regions);
  free(t->cursors);
  free(t->stack);
  free(t->walk.ents);
  free(t->walk.hash);
  free(t->walk.edges);
  free(t->walk.work);
  memset(t, 0, sizeof *t);
  t->exit_registered = true; /* the cleanup ran; a late allocation keeps its memory */
}

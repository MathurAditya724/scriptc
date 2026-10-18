/* White-box checks for the small-object allocator (scr_alloc.c). Built by
 * scr_alloc.test.ts without ASan (the size-class allocator is live), with
 * ASan (every call must reach the system allocator), and as a worker
 * executable's allocator (per-thread arenas, also under ThreadSanitizer). */
#include "scr_runtime.h"
#include <assert.h>
#include <stdio.h>

#if SCR_SMALL_ALLOC
static bool owned(const void *p) { return (uintptr_t)p - scr_sa.base < scr_sa.span; }
#endif

static void fill(unsigned char *p, size_t n, unsigned char seed) {
  for (size_t i = 0; i < n; i++) p[i] = (unsigned char)(seed + i * 7);
}

static void verify(const unsigned char *p, size_t n, unsigned char seed) {
  for (size_t i = 0; i < n; i++) assert(p[i] == (unsigned char)(seed + i * 7));
}

/* Blocks are 8-byte aligned, and 16-byte aligned for multiples of 16. */
static bool aligned(const void *p, size_t n) {
  return ((uintptr_t)p & (n % 16 ? 7 : 15)) == 0;
}

/* Classes step by 8 bytes up to SCR_SA_FINE_MAX and by 16 above it; the
 * class of 49 to 56-byte requests holds 64-byte blocks. */
static void check_classes(void) {
  unsigned prev = 0;
  for (size_t n = 1; n <= SCR_SA_MAX; n++) {
    unsigned c = scr_sa_class(n);
    size_t sz = scr_sa_class_size(c), step = n <= SCR_SA_FINE_MAX ? 8u : 16u;
    assert(c < SCR_SA_NCLASS && (c == prev || c == prev + 1));
    if (n > 48 && n <= 56) assert(sz == 64);
    else assert(sz >= n && sz - n < step && sz % step == 0);
    prev = c;
  }
  assert(scr_sa_class(SCR_SA_MAX) == SCR_SA_NCLASS - 1);
  assert(scr_sa_class_size(SCR_SA_NCLASS - 1) == SCR_SA_MAX);
}

static void check_alignment_and_zeroing(void) {
  for (size_t n = 1; n <= 600; n++) {
    unsigned char *p = scr_mem_calloc(n);
    assert(p && aligned(p, n));
    for (size_t i = 0; i < n; i++) assert(p[i] == 0);
    fill(p, n, (unsigned char)n);
    scr_mem_free(p);
    /* A recycled block (same class, LIFO) must come back zeroed. */
    unsigned char *q = scr_mem_calloc(n);
    assert(q && aligned(q, n));
    for (size_t i = 0; i < n; i++) assert(q[i] == 0);
#if SCR_SMALL_ALLOC
    if (n <= SCR_SA_MAX) assert(q == p && owned(q));
    else assert(!owned(q));
#endif
    scr_mem_free(q);
  }
}

static void check_realloc(void) {
  unsigned char *p = scr_mem_realloc(NULL, 10);
  fill(p, 10, 3);
  size_t sizes[] = {12, 16, 17, 100, 512, 513, 4000, 300, 40, 24, 16, 7};
  size_t live = 10;
  for (size_t i = 0; i < sizeof(sizes) / sizeof(sizes[0]); i++) {
    size_t n = sizes[i];
    p = scr_mem_realloc(p, n);
    assert(p && aligned(p, n));
    verify(p, live < n ? live : n, 3);
    fill(p, n, 3);
    live = n;
  }
  scr_mem_free(p);
}

static void check_system_pointers(void) {
  /* scr_mem_free / scr_mem_realloc accept blocks the system allocated. */
  void *a = malloc(32), *b = calloc(1, 4096), *c = malloc(24);
  assert(a && b && c);
  scr_mem_free(a);
  b = scr_mem_realloc(b, 8192);
  assert(b);
  scr_mem_free(b);
  c = scr_mem_realloc(c, 64);
  assert(c);
  scr_mem_free(c);
  scr_mem_free(NULL);
  scr_mem_free(scr_mem_alloc(0)); /* malloc(0) contract: NULL or freeable */
}

/* Interleaved alloc/free across every class: blocks never overlap and a
 * live block's contents survive unrelated traffic. */
static void check_churn(void) {
  enum { SLOTS = 4096 };
  static unsigned char *slot[SLOTS];
  static size_t len[SLOTS];
  uint32_t x = 0x9e3779b9u;
  for (unsigned round = 0; round < 400000; round++) {
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    unsigned i = x % SLOTS;
    if (slot[i]) {
      verify(slot[i], len[i], (unsigned char)i);
      scr_rt_free(slot[i]);
      slot[i] = NULL;
    } else {
      len[i] = 1 + (x >> 12) % 700;
      slot[i] = (x & 1) ? scr_rt_calloc(len[i]) : scr_mem_alloc(len[i]);
      assert(slot[i]);
      fill(slot[i], len[i], (unsigned char)i);
    }
  }
  for (unsigned i = 0; i < SLOTS; i++) {
    if (!slot[i]) continue;
    verify(slot[i], len[i], (unsigned char)i);
    scr_mem_free(slot[i]);
  }
}

/* scr_mem_order_for_free keeps every pointer, puts system blocks first and
 * each class's blocks in descending address order, and freeing in that
 * order hands each class's blocks back in ascending address order. Builds
 * without the size-class allocator leave the array as it is. */
static int compare_pointers(const void *a, const void *b) {
  uintptr_t x = (uintptr_t)*(void *const *)a, y = (uintptr_t)*(void *const *)b;
  return x < y ? -1 : x > y;
}

static void check_free_order(void) {
  enum { BLOCKS = 12000, SYSTEM = 64, N = BLOCKS + SYSTEM };
  static void *ptrs[N], *before[N], *a[N], *b[N];
  const size_t sizes[2] = {32, 96};
  for (size_t i = 0; i < BLOCKS; i++) ptrs[i] = scr_mem_alloc(sizes[i % 2]);
  for (size_t i = BLOCKS; i < N; i++) ptrs[i] = malloc(1024);
  uint32_t x = 0x2545f491u;
  for (size_t i = N - 1; i > 0; i--) {
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    size_t j = x % (i + 1);
    void *t = ptrs[i];
    ptrs[i] = ptrs[j];
    ptrs[j] = t;
  }
  memcpy(before, ptrs, sizeof ptrs);
  scr_mem_order_for_free(ptrs, N, 0);
  memcpy(a, ptrs, sizeof ptrs);
  memcpy(b, before, sizeof before);
  qsort(a, N, sizeof *a, compare_pointers);
  qsort(b, N, sizeof *b, compare_pointers);
  assert(memcmp(a, b, sizeof a) == 0);
#if SCR_SMALL_ALLOC
  size_t i = 0;
  uintptr_t last[SCR_SA_NCLASS] = {0};
  for (; i < SYSTEM; i++) assert(!owned(ptrs[i]));
  for (; i < N; i++) {
    assert(owned(ptrs[i]));
    unsigned c = (unsigned)(((uintptr_t)ptrs[i] - scr_sa.base) >> scr_sa.shift);
    assert(!last[c] || (uintptr_t)ptrs[i] < last[c]);
    last[c] = (uintptr_t)ptrs[i];
  }
  for (i = 0; i < N; i++) scr_mem_free(ptrs[i]);
  for (size_t c = 0; c < 2; c++) {
    for (size_t k = 0; k < BLOCKS / 2; k++) {
      a[k] = scr_mem_alloc(sizes[c]);
      if (k) assert(a[k] > a[k - 1]);
    }
    for (size_t k = 0; k < BLOCKS / 2; k++) scr_mem_free(a[k]);
  }
#else
  assert(memcmp(ptrs, before, sizeof ptrs) == 0);
  for (size_t i = 0; i < N; i++) scr_mem_free(ptrs[i]);
#endif
}

#if SCR_SMALL_ALLOC
#include <string.h>
#ifdef __linux__
/* The VmFlags line of the mapping that contains p, or "". */
static void vm_flags(const void *p, char *out, size_t cap) {
  out[0] = '\0';
  FILE *f = fopen("/proc/self/smaps", "r");
  assert(f);
  char line[512];
  bool inside = false;
  while (fgets(line, sizeof line, f)) {
    unsigned long lo, hi;
    if (sscanf(line, "%lx-%lx ", &lo, &hi) == 2 && strchr(line, '-') < strchr(line, ' ')) {
      inside = (uintptr_t)p >= lo && (uintptr_t)p < hi;
    } else if (inside && !strncmp(line, "VmFlags:", 8)) {
      snprintf(out, cap, "%s", line + 8);
      break;
    }
  }
  fclose(f);
}
#endif

/* A class slice carves contiguously from its start, across the points where
 * its limit is raised; on Linux the slices are huge-page aligned, the first
 * 8 MiB of a slice stay on small pages and the rest may use huge pages, a
 * helper thread faults in memory ahead of the limit, and only the slice up
 * to its limit is included in core dumps. Every fresh block
 * still reads as zero, wherever the limit steps and whoever faulted it. */
static void check_slice_growth(void) {
  enum { SZ = 496, AFTER = 8 << 20, PAST = 3 * (2 << 20) + (1 << 20) };
  unsigned char *first = scr_mem_alloc(SZ), *prev = first;
  assert(owned(first));
  uintptr_t start = scr_sa.base + ((uintptr_t)scr_sa_class(SZ) << scr_sa.shift);
  assert((uintptr_t)first == start); /* a class nothing else has touched */
  size_t blocks = (AFTER + PAST) / SZ;
  for (size_t i = 1; i < blocks; i++) {
    unsigned char *p = scr_mem_alloc(SZ);
    assert(p == prev + SZ);
    for (size_t k = 0; k < SZ; k += 16) assert(p[k] == 0);
    p[0] = (unsigned char)i; /* commit the pages */
    p[SZ - 1] = (unsigned char)i;
    prev = p;
  }
#ifdef __linux__
  assert((scr_sa.base & ((2u << 20) - 1)) == 0);
  FILE *thp = fopen("/sys/kernel/mm/transparent_hugepage/enabled", "r");
  if (thp) { /* a kernel without THP refuses both advices */
    fclose(thp);
    char flags[256];
    vm_flags(first, flags, sizeof flags);
    assert(strstr(flags, " nh") && !strstr(flags, " hg"));
    vm_flags((void *)(start + AFTER), flags, sizeof flags);
    assert(strstr(flags, " hg") && !strstr(flags, " nh"));
  }
  /* Core dumps hold the carved blocks but not the untouched rest of the
   * reservation (" dd" is VM_DONTDUMP). */
  char flags[256];
  vm_flags(first, flags, sizeof flags);
  assert(!strstr(flags, " dd"));
  vm_flags(prev + SZ - 1, flags, sizeof flags);
  assert(!strstr(flags, " dd"));
  vm_flags((void *)(start + ((uintptr_t)1 << scr_sa.shift) - 1), flags, sizeof flags);
  assert(strstr(flags, " dd"));
  vm_flags((void *)(scr_sa.base + scr_sa.span - 1), flags, sizeof flags);
  assert(strstr(flags, " dd"));
#endif
  /* The blocks recycle through the free list like any others. */
  for (size_t i = blocks; i-- > 0;) scr_mem_free(first + i * SZ);
  assert(scr_mem_alloc(SZ) == first);
  scr_mem_free(first);
}

#if defined(__linux__) && defined(__GLIBC__)
#include <unistd.h>
/* Blocks above SCR_SA_MAX come from glibc; once its brk heap has grown past
 * 32 MiB, the heap is advised huge pages where THP is in madvise mode. */
static void check_heap_huge_pages(void) {
  enum { N = 1024, SZ = 64 << 10 };
  static unsigned char *block[N];
  uintptr_t start = (uintptr_t)sbrk(0);
  for (size_t i = 0; i < N; i++) {
    block[i] = scr_mem_alloc(SZ);
    assert(block[i] && !owned(block[i]));
    block[i][0] = (unsigned char)i;
  }
  uintptr_t top = (uintptr_t)sbrk(0);
  char mode[96] = {0};
  FILE *thp = fopen("/sys/kernel/mm/transparent_hugepage/enabled", "r");
  if (thp) {
    size_t n = fread(mode, 1, sizeof mode - 1, thp);
    mode[n] = '\0';
    fclose(thp);
  }
  /* Only where glibc's heap served them (a sanitizer may replace malloc). */
  if (top - start >= ((size_t)48 << 20) && strstr(mode, "[madvise]")) {
    char flags[256];
    vm_flags(block[N - 1], flags, sizeof flags);
    assert(strstr(flags, " hg"));
  }
  for (size_t i = 0; i < N; i++) {
    assert(block[i][0] == (unsigned char)i);
    scr_mem_free(block[i]);
  }
}
#endif
#endif

#if defined(SCR_WORKERS) && SCR_SMALL_ALLOC
#include <pthread.h>

/* Script threads own disjoint arenas; blocks freed by another thread return
 * to their owner through its remote list, and an exiting thread's arena
 * (free lists included) passes to the next thread that claims one. */
enum { HANDOFF = 256 };
static void *handoff[HANDOFF];
static void *handed[HANDOFF]; /* the addresses, kept after the frees */
static uintptr_t worker_base;

static void *alloc_and_hand_off(void *arg) {
  (void)arg;
  for (unsigned i = 0; i < HANDOFF; i++) {
    handoff[i] = scr_mem_calloc(48);
    assert(handoff[i] && owned(handoff[i]));
    handed[i] = handoff[i];
    fill(handoff[i], 48, (unsigned char)i);
  }
  worker_base = scr_sa.base;
  scr_sa_thread_park();
  return NULL;
}

static void *reclaim_arena(void *arg) {
  (void)arg;
  /* The parked arena is the only free one besides main's: claimed again,
   * with the main thread's remote frees drained into its free lists. */
  void *p = scr_mem_alloc(48);
  assert(scr_sa.base == worker_base);
  bool recycled = false;
  for (unsigned i = 0; i < HANDOFF; i++) recycled |= p == handed[i];
  assert(recycled);
  scr_mem_free(p);
  scr_sa_thread_park();
  return NULL;
}

static void check_threads(void) {
  void *mine = scr_mem_alloc(48);
  assert(owned(mine));
  pthread_t t;
  assert(pthread_create(&t, NULL, alloc_and_hand_off, NULL) == 0);
  assert(pthread_join(t, NULL) == 0);
  assert(worker_base != scr_sa.base);
  for (unsigned i = 0; i < HANDOFF; i++) {
    assert(!owned(handoff[i]));
    verify(handoff[i], 48, (unsigned char)i);
    if (i == 0) {
      handoff[0] = scr_mem_realloc(handoff[0], 600); /* moves to the system */
      verify(handoff[0], 48, 0);
      free(handoff[0]);
      handoff[0] = NULL;
    } else scr_mem_free(handoff[i]); /* remote free */
  }
  assert(pthread_create(&t, NULL, reclaim_arena, NULL) == 0);
  assert(pthread_join(t, NULL) == 0);
  scr_mem_free(mine);
}
#endif

#if defined(SCR_WORKERS) && SCR_SMALL_ALLOC && defined(__linux__)
#include <sys/mman.h>
#include <unistd.h>

/* An exiting thread returns the pages that hold only free blocks; the next
 * thread to claim the arena carves the returned range again, zeroed, before
 * growing the slice. */
enum { TRIM_BLOCKS = 1 << 20, TRIM_KEEP = 4096, TRIM_SIZE = 48 };
static unsigned char **trim_blocks;
static unsigned char *trim_kept[TRIM_BLOCKS / TRIM_KEEP];
static uintptr_t trim_lo, trim_hi;
static size_t trim_outside;

static size_t resident_pages(uintptr_t lo, uintptr_t hi) {
  size_t page = (size_t)sysconf(_SC_PAGESIZE);
  lo &= ~(uintptr_t)(page - 1);
  size_t n = (hi - lo + page - 1) / page, count = 0;
  unsigned char *vec = malloc(n);
  assert(vec && mincore((void *)lo, n * page, vec) == 0);
  for (size_t i = 0; i < n; i++) count += vec[i] & 1;
  free(vec);
  return count;
}

static void *trim_allocate(void *arg) {
  (void)arg;
  trim_lo = UINTPTR_MAX;
  trim_hi = 0;
  for (size_t i = 0; i < TRIM_BLOCKS; i++) {
    trim_blocks[i] = scr_mem_alloc(TRIM_SIZE);
    assert(trim_blocks[i] && owned(trim_blocks[i]));
    fill(trim_blocks[i], TRIM_SIZE, (unsigned char)i);
    if ((uintptr_t)trim_blocks[i] < trim_lo) trim_lo = (uintptr_t)trim_blocks[i];
    if ((uintptr_t)trim_blocks[i] + TRIM_SIZE > trim_hi) trim_hi = (uintptr_t)trim_blocks[i] + TRIM_SIZE;
  }
  for (size_t i = 0; i < TRIM_BLOCKS; i++) {
    if (i % TRIM_KEEP == 0) trim_kept[i / TRIM_KEEP] = trim_blocks[i];
    else scr_mem_free(trim_blocks[i]);
  }
  scr_sa_thread_park();
  return NULL;
}

static void *trim_reuse(void *arg) {
  (void)arg;
  trim_outside = 0;
  for (size_t i = 0; i < TRIM_BLOCKS; i++) {
    unsigned char *p = scr_mem_calloc(TRIM_SIZE);
    assert(p && owned(p));
    for (size_t k = 0; k < TRIM_SIZE; k++) assert(p[k] == 0);
    fill(p, TRIM_SIZE, (unsigned char)i);
    if ((uintptr_t)p < trim_lo || (uintptr_t)p >= trim_hi) trim_outside++;
    trim_blocks[i] = p;
  }
  for (size_t i = 0; i < TRIM_BLOCKS; i++) scr_mem_free(trim_blocks[i]);
  scr_sa_thread_park();
  return NULL;
}

static void check_trim(void) {
  trim_blocks = malloc(TRIM_BLOCKS * sizeof *trim_blocks);
  assert(trim_blocks);
  pthread_t t;
  assert(pthread_create(&t, NULL, trim_allocate, NULL) == 0);
  assert(pthread_join(t, NULL) == 0);
  scr_sa_wait_trims(); /* a helper thread returns the pages */
  /* One page per kept block stays, give or take the pages at run ends. */
  size_t total = (trim_hi - trim_lo) / (size_t)sysconf(_SC_PAGESIZE);
  size_t resident = resident_pages(trim_lo, trim_hi);
  assert(resident < total / 8);
  for (size_t k = 0; k < TRIM_BLOCKS / TRIM_KEEP; k++)
    verify(trim_kept[k], TRIM_SIZE, (unsigned char)(k * TRIM_KEEP));
  assert(pthread_create(&t, NULL, trim_reuse, NULL) == 0);
  assert(pthread_join(t, NULL) == 0);
  scr_sa_wait_trims();
  /* Nearly every block came from the returned range: the slice did not grow. */
  assert(trim_outside < 4 * TRIM_BLOCKS / TRIM_KEEP + 256);
  for (size_t k = 0; k < TRIM_BLOCKS / TRIM_KEEP; k++) {
    verify(trim_kept[k], TRIM_SIZE, (unsigned char)(k * TRIM_KEEP));
    scr_mem_free(trim_kept[k]); /* remote free into the parked arena */
  }
  free(trim_blocks);
}
#endif

int main(void) {
#if SCR_SMALL_ALLOC
  check_slice_growth(); /* first: its class must be untouched */
#endif
  check_classes();
  check_alignment_and_zeroing();
  check_realloc();
  check_system_pointers();
  check_churn();
  check_free_order();
#if SCR_SMALL_ALLOC && defined(__linux__) && defined(__GLIBC__)
  check_heap_huge_pages();
#endif
#if defined(SCR_WORKERS) && SCR_SMALL_ALLOC
  check_threads();
#ifdef __linux__
  check_trim();
#endif
  printf("allocator checks passed: size-class workers\n");
#else
  printf("allocator checks passed: %s\n", SCR_SMALL_ALLOC ? "size-class" : "system");
#endif
  return 0;
}

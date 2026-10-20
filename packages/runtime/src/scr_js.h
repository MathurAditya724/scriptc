/* scriptc runtime — dynamic-tier values (jsval): the value representation of
 * the two-tier design's dynamic tier (scr_js_value.c). Only dynamic-tier
 * units (scr_js_*.c) include this header: static runtime units never see a
 * jsval, and the compiler links these units only into programs whose IR has
 * a dynamic-tier operation (the dynTier runtime feature). The header test
 * enforces the include rule.
 *
 * A jsval is one 64-bit NaN-boxed word. The compiler passes it as an LLVM
 * `ptr`, so the C API spells it `ScrJsVal` (void *) and reads the bits
 * through scr_js_bits:
 *
 *   bits below SCR_JS_DOUBLE_LIMIT   an IEEE double; every NaN is the
 *                                    canonical 0x7FF8000000000000
 *   0xFFF9 << 48 | n                 undefined (0), null (1), false (2),
 *                                    true (3)
 *   0xFFFA << 48 | ptr               a ScrDyn cell (objects, arrays,
 *                                    functions, capsules and every other
 *                                    checked-dynamic value; a NUM, BOOL,
 *                                    NULL or UNDEF cell is a valid jsval and
 *                                    means its value)
 *   0xFFFB << 48 | ptr               a string: the static tier's ScrStr
 *   0xFFFC << 48 | ptr               a BigInt: the static tier's ScrBigInt
 *   0xFFFD, 0xFFFE                   reserved (symbols; int32 immediates)
 *
 * The three heap tags are contiguous, so "does this word own a reference"
 * is one subtract and one compare. Pointers fit in 48 bits on every 64-bit
 * target scriptc supports. On 32-bit targets (wasm32) a pointer cannot hold
 * a double, so a jsval there is a ScrDyn cell pointer: every number is a
 * cell, and these helpers keep the same API over that boxed form.
 *
 * Ownership follows the dyn conventions: arguments are borrowed, results
 * are owned (+1), and a call that throws leaves the exception pending and
 * returns undefined. */
#ifndef SCR_JS_H
#define SCR_JS_H

#include "scr_dyn.h"
#include "scr_number.h"

#include <math.h>
#include <stdint.h>
#include <string.h>

typedef void *ScrJsVal;

#if UINTPTR_MAX > 0xFFFFFFFFu
#define SCR_JS_IMMEDIATES 1
#else
#define SCR_JS_IMMEDIATES 0
#endif

#if SCR_JS_IMMEDIATES

#define SCR_JS_TAG_SHIFT 48
#define SCR_JS_TAG_SPECIAL UINT64_C(0xFFF9)
#define SCR_JS_TAG_CELL UINT64_C(0xFFFA)
#define SCR_JS_TAG_STR UINT64_C(0xFFFB)
#define SCR_JS_TAG_BIGINT UINT64_C(0xFFFC)
#define SCR_JS_DOUBLE_LIMIT (SCR_JS_TAG_SPECIAL << SCR_JS_TAG_SHIFT)
#define SCR_JS_PAYLOAD_MASK ((UINT64_C(1) << SCR_JS_TAG_SHIFT) - 1)
#define SCR_JS_CANONICAL_NAN UINT64_C(0x7FF8000000000000)
#define SCR_JS_UNDEFINED_BITS (SCR_JS_DOUBLE_LIMIT | 0)
#define SCR_JS_NULL_BITS (SCR_JS_DOUBLE_LIMIT | 1)
#define SCR_JS_FALSE_BITS (SCR_JS_DOUBLE_LIMIT | 2)
#define SCR_JS_TRUE_BITS (SCR_JS_DOUBLE_LIMIT | 3)

static inline uint64_t scr_js_bits(ScrJsVal v) { return (uint64_t)(uintptr_t)v; }
static inline ScrJsVal scr_js_of_bits(uint64_t bits) { return (ScrJsVal)(uintptr_t)bits; }
static inline uint64_t scr_js_tag(ScrJsVal v) { return scr_js_bits(v) >> SCR_JS_TAG_SHIFT; }
static inline void *scr_js_payload(ScrJsVal v) {
  return (void *)(uintptr_t)(scr_js_bits(v) & SCR_JS_PAYLOAD_MASK);
}

static inline bool scr_js_is_double(ScrJsVal v) { return scr_js_bits(v) < SCR_JS_DOUBLE_LIMIT; }
static inline double scr_js_double(ScrJsVal v) {
  double d;
  uint64_t bits = scr_js_bits(v);
  memcpy(&d, &bits, sizeof d);
  return d;
}
static inline ScrJsVal scr_js_from_double(double d) {
  uint64_t bits;
  memcpy(&bits, &d, sizeof bits);
  return scr_js_of_bits(d != d ? SCR_JS_CANONICAL_NAN : bits);
}
static inline bool scr_js_is_heap(ScrJsVal v) {
  return scr_js_tag(v) - SCR_JS_TAG_CELL <= SCR_JS_TAG_BIGINT - SCR_JS_TAG_CELL;
}
static inline bool scr_js_is_cell(ScrJsVal v) { return scr_js_tag(v) == SCR_JS_TAG_CELL; }
static inline ScrDyn *scr_js_cell(ScrJsVal v) { return (ScrDyn *)scr_js_payload(v); }
static inline ScrJsVal scr_js_of_cell(ScrDyn *d) {
  return scr_js_of_bits((SCR_JS_TAG_CELL << SCR_JS_TAG_SHIFT) | (uint64_t)(uintptr_t)d);
}
static inline bool scr_js_is_str(ScrJsVal v) { return scr_js_tag(v) == SCR_JS_TAG_STR; }
static inline ScrStr *scr_js_str(ScrJsVal v) { return (ScrStr *)scr_js_payload(v); }
static inline ScrJsVal scr_js_of_str(ScrStr *s) {
  return scr_js_of_bits((SCR_JS_TAG_STR << SCR_JS_TAG_SHIFT) | (uint64_t)(uintptr_t)s);
}
static inline bool scr_js_is_bigint(ScrJsVal v) { return scr_js_tag(v) == SCR_JS_TAG_BIGINT; }
static inline ScrBigInt *scr_js_bigint(ScrJsVal v) { return (ScrBigInt *)scr_js_payload(v); }
static inline ScrJsVal scr_js_of_bigint(ScrBigInt *b) {
  return scr_js_of_bits((SCR_JS_TAG_BIGINT << SCR_JS_TAG_SHIFT) | (uint64_t)(uintptr_t)b);
}
static inline ScrJsVal scr_js_undefined(void) { return scr_js_of_bits(SCR_JS_UNDEFINED_BITS); }
static inline ScrJsVal scr_js_null(void) { return scr_js_of_bits(SCR_JS_NULL_BITS); }
static inline ScrJsVal scr_js_bool(bool b) {
  return scr_js_of_bits(b ? SCR_JS_TRUE_BITS : SCR_JS_FALSE_BITS);
}

#else /* boxed: every jsval is a ScrDyn cell */

static inline bool scr_js_is_double(ScrJsVal v) {
  (void)v;
  return false;
}
static inline double scr_js_double(ScrJsVal v) { return ((ScrDyn *)v)->v.num; }
static inline ScrJsVal scr_js_from_double(double d) { return scr_dyn_new_num(d); }
static inline bool scr_js_is_heap(ScrJsVal v) { return v != NULL; }
static inline bool scr_js_is_cell(ScrJsVal v) { return v != NULL; }
static inline ScrDyn *scr_js_cell(ScrJsVal v) { return (ScrDyn *)v; }
static inline ScrJsVal scr_js_of_cell(ScrDyn *d) { return d; }
static inline bool scr_js_is_str(ScrJsVal v) {
  (void)v;
  return false;
}
static inline ScrStr *scr_js_str(ScrJsVal v) { return ((ScrDyn *)v)->v.str; }
static inline bool scr_js_is_bigint(ScrJsVal v) {
  (void)v;
  return false;
}
static inline ScrBigInt *scr_js_bigint(ScrJsVal v) { return ((ScrDyn *)v)->v.bigint; }
static inline ScrJsVal scr_js_undefined(void) { return scr_dyn_undefined(); }
static inline ScrJsVal scr_js_null(void) { return scr_dyn_new_null(); }
static inline ScrJsVal scr_js_bool(bool b) { return scr_dyn_new_bool(b); }

#endif

/* Whether a jsval is a number (an immediate double or a NUM cell), and its
 * value. */
static inline bool scr_js_number(ScrJsVal v, double *out) {
  if (scr_js_is_double(v)) {
    *out = scr_js_double(v);
    return true;
  }
  if (scr_js_is_cell(v)) {
    const ScrDyn *d = scr_js_cell(v);
    if (d && d->kind == SCR_DYN_NUM) {
      *out = d->v.num;
      return true;
    }
  }
  return false;
}

/* ── reference counting (NULL-tolerant; immediates are unchanged) ───── */
ScrJsVal scr_js_retain(ScrJsVal v);
void scr_js_release(ScrJsVal v);
void *scr_js_retain_v(void *v);
void scr_js_release_v(void *v);

/* ── boundary conversions ──────────────────────────────────────────────
 * dyn → jsval keeps a cell's identity under the cell tag (from_dyn
 * consumes the cell); jsval → dyn boxes an immediate into a cell, a number
 * through scr_dyn_new_num (to_dyn consumes, to_dyn_borrow borrows). */
ScrJsVal scr_js_from_dyn(ScrDyn *d);
ScrDyn *scr_js_to_dyn(ScrJsVal v);
ScrDyn *scr_js_to_dyn_borrow(ScrJsVal v);
ScrJsVal scr_js_from_str(ScrStr *s);       /* borrows and retains s */
ScrJsVal scr_js_from_bigint(ScrBigInt *b); /* borrows and retains b */

/* ── operators (the dyn.* operators of scr_json.c over jsvals) ──────────
 * Each implements its dyn twin's JS semantics exactly, including
 * ToPrimitive order; the compiler inlines the number cases. */
ScrJsVal scr_js_add(ScrJsVal left, ScrJsVal right);
ScrJsVal scr_js_arithmetic(ScrJsVal left, ScrJsVal right, const ScrStr *operation);
ScrJsVal scr_js_bitwise(ScrJsVal left, ScrJsVal right, const ScrStr *operation);
bool scr_js_compare(ScrJsVal left, ScrJsVal right, const ScrStr *operation);
ScrJsVal scr_js_to_numeric(ScrJsVal value);
ScrJsVal scr_js_increment(ScrJsVal value, bool increment);
double scr_js_to_number(ScrJsVal value);
bool scr_js_truthy(ScrJsVal value);

#endif

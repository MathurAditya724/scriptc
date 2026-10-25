/* Declared-type origins on checked-conversion TypeErrors, linked only by
 * programs that check values against types an npm package declares
 * (runtime feature typeOrigins).
 *
 * A checked conversion into a type that comes from a package's
 * declarations (its .d.ts, @types package or JSDoc) throws the usual
 * `expected <type> at <path>, got <kind>` TypeError when the value does
 * not fit. The compiler passes the declaration's origin to the conversion
 * site's cold exception path, which calls scr_type_origin_note: the
 * pending TypeError's message gains two lines naming the declaration and
 * the type patch (package.json scriptc.typePatches) that would make the
 * declaration admit the value. The hot path is unchanged, and so is every
 * other error.
 *
 * The origin is one string of fields separated by \x1f: package, version,
 * suggested range, the selector of the declared slot, where it is
 * declared, and the declared type. */
#include "scr_runtime.h"

#include <stdlib.h>
#include <string.h>

typedef struct {
  char *data;
  size_t len, cap;
} ScrOriginBuf;

static void scr_origin_put(ScrOriginBuf *b, const char *s, size_t n) {
  if (b->len + n + 1 > b->cap) {
    size_t cap = b->cap ? b->cap : 256;
    while (b->len + n + 1 > cap) cap *= 2;
    char *grown = realloc(b->data, cap);
    if (!grown) scr_trap("scriptc: out of memory\n");
    b->data = grown;
    b->cap = cap;
  }
  memcpy(b->data + b->len, s, n);
  b->len += n;
  b->data[b->len] = 0;
}

static void scr_origin_puts(ScrOriginBuf *b, const char *s) { scr_origin_put(b, s, strlen(s)); }

/* Field `index` of the origin string (not terminated: [*out, *out+len)). */
static size_t scr_origin_field(const char *origin, int index, const char **out) {
  const char *p = origin;
  for (int i = 0; i < index; i++) {
    const char *sep = strchr(p, '\x1f');
    if (!sep) {
      *out = "";
      return 0;
    }
    p = sep + 1;
  }
  const char *end = strchr(p, '\x1f');
  *out = p;
  return end ? (size_t)(end - p) : strlen(p);
}

/* The TypeScript type a `got` kind of the check message suggests adding. */
static const char *scr_origin_arm(const char *kind, size_t len) {
  if (len == 5 && memcmp(kind, "array", 5) == 0) return "unknown[]";
  if (len == 8 && memcmp(kind, "function", 8) == 0) return "Function";
  return NULL; /* the kind itself (undefined, null, string, number, ...) */
}

void scr_type_origin_note(const char *origin) {
  ScrExcCell *cell = scr_exc_current_cell();
  if (cell->kind != SCR_EXC_OBJ || cell->payload == NULL) return;
  ScrError *e = (ScrError *)cell->payload;
  if (e->vt != &scr_error_vts[SCR_ERR_TYPE] || e->message == NULL) return;
  const char *msg = e->message->data;
  size_t mlen = e->message->len;
  if (memchr(msg, '\n', mlen) != NULL) return; /* already noted */
  /* `expected <type> at <path>, got <kind>`: the path extends the
   * declared slot's selector, the kind is what the patch admits. */
  const char *path = NULL, *got = NULL;
  size_t path_len = 0, got_len = 0;
  if (mlen > 9 && memcmp(msg, "expected ", 9) == 0) {
    for (size_t i = mlen; i-- > 7;) {
      if (memcmp(msg + i - 6, ", got ", 6) == 0) {
        got = msg + i;
        got_len = mlen - i;
        for (size_t j = i - 6; j-- > 4;) {
          if (memcmp(msg + j - 4, " at $", 5) == 0) {
            path = msg + j;
            path_len = i - 6 - j;
            break;
          }
        }
        break;
      }
    }
  }
  const char *pkg, *version, *range, *selector, *where, *declared;
  size_t pkg_len = scr_origin_field(origin, 0, &pkg);
  size_t version_len = scr_origin_field(origin, 1, &version);
  size_t range_len = scr_origin_field(origin, 2, &range);
  size_t selector_len = scr_origin_field(origin, 3, &selector);
  size_t where_len = scr_origin_field(origin, 4, &where);
  size_t declared_len = scr_origin_field(origin, 5, &declared);

  ScrOriginBuf b = {0};
  scr_origin_put(&b, msg, mlen);
  scr_origin_puts(&b, "\n    ");
  scr_origin_put(&b, pkg, pkg_len);
  if (version_len > 0) {
    scr_origin_puts(&b, "@");
    scr_origin_put(&b, version, version_len);
  }
  scr_origin_puts(&b, " declares ");
  scr_origin_put(&b, selector, selector_len);
  if (declared_len > 0) {
    scr_origin_puts(&b, " as ");
    scr_origin_put(&b, declared, declared_len);
  }
  scr_origin_puts(&b, " (");
  scr_origin_put(&b, where, where_len);
  scr_origin_puts(&b, ")\n    if that declaration is wrong, patch it in package.json: \"scriptc\": { \"typePatches\": { \"");
  scr_origin_put(&b, pkg, pkg_len);
  scr_origin_puts(&b, "@");
  scr_origin_put(&b, range, range_len);
  scr_origin_puts(&b, "\": { \"declarations\": { \"");
  scr_origin_put(&b, selector, selector_len);
  /* $[3].email extends the selector as [].email: elements of an array
   * share one declared type. */
  for (size_t i = 1; path != NULL && i < path_len; i++) {
    if (path[i] == '[') {
      scr_origin_puts(&b, "[]");
      while (i < path_len && path[i] != ']') i++;
    } else {
      scr_origin_put(&b, path + i, 1);
    }
  }
  scr_origin_puts(&b, "\": \"| ");
  if (got != NULL) {
    const char *arm = scr_origin_arm(got, got_len);
    if (arm != NULL) scr_origin_puts(&b, arm);
    else scr_origin_put(&b, got, got_len);
  } else {
    scr_origin_puts(&b, "undefined");
  }
  scr_origin_puts(&b, "\" } } } }");

  ScrStr *next = scr_str_new(b.data, b.len);
  free(b.data);
  scr_str_release(e->message);
  e->message = next;
  if (e->stack != NULL) {
    /* The cached `stack` starts with the message. */
    scr_str_release(e->stack);
    e->stack = NULL;
  }
}

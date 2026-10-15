/* scriptc runtime — JSON parsing and the JSON output buffer (scr_json.c).
 * Included by scr_runtime.h, which says where new declarations go. */
#ifndef SCR_JSON_H
#define SCR_JSON_H

#include "scr_dyn.h"

/* RFC 8259 parse of a UTF-8 string. Borrows text; returns +1, or throws a
 * catchable Node-flavored SyntaxError string and returns NULL (callers are
 * compiler-emitted pending checks — json.parse is in the may-throw seed). */
ScrDyn *scr_json_parse(ScrStr *text);

/* Compiler-emitted description of a statically known JSON.parse target
 * (`JSON.parse(text) as T`). Constant data in the program image; the LLVM
 * backend mirrors this layout ({size, size, ptr, ptr, ptr, ptr, ptr} and
 * {ptr, size, size, ptr}). Records list their declared fields (at most
 * 64), each with its byte offset in the record struct; bool fields are one
 * byte, f64 fields doubles, every other kind a +1 pointer. */
enum {
  SCR_JSCHEMA_F64 = 0,
  SCR_JSCHEMA_BOOL = 1,
  SCR_JSCHEMA_STR = 2,
  SCR_JSCHEMA_REC = 3,
  SCR_JSCHEMA_ARR = 4,
};
typedef struct ScrJsonSchema ScrJsonSchema;
typedef struct {
  const char *name;
  size_t name_len;
  size_t offset;
  const ScrJsonSchema *type;
} ScrJsonSchemaField;
struct ScrJsonSchema {
  size_t kind;
  size_t nfields;
  const ScrJsonSchemaField *fields; /* records */
  const ScrJsonSchema *elem;        /* arrays */
  void *(*rec_new)(void);           /* records: zeroed instance, rc 1 */
  ScrArr *(*arr_new)(size_t);       /* arrays: empty array of the element kind */
  void (*release)(void *);          /* records and arrays */
};

/* One-pass parse straight into the native layout. Returns the +1 record
 * or array, or NULL WITHOUT throwing whenever the checked-dynamic route
 * (scr_json_parse + dynCheck) might fail or differ; the caller then runs
 * that route, which reports the exact error. */
void *scr_json_parse_schema(const ScrStr *text, const ScrJsonSchema *schema);

/* Native JSON callbacks. All inputs borrowed, result owned (+1), NULL on
 * pending exception. Stringify returns a dyn string OR actual undefined
 * when the replacer omits the root. An array replacer selects the object
 * keys to serialize. gap has already applied space rules. */
ScrDyn *scr_json_parse_reviver(ScrStr *text, const ScrDyn *reviver);
ScrDyn *scr_json_stringify_replacer(const ScrDyn *value, const ScrDyn *replacer, const ScrStr *gap);
ScrDyn *scr_json_stringify_value(const ScrDyn *value, const ScrDyn *replacer, const ScrDyn *space);

/* Output buffer for the compiler-emitted type-directed JSON serializers.
 * Value-typed and stack-allocated by the emitted code; _finish hands the
 * bytes over as a +1 ScrStr and frees the buffer storage (including the
 * circular-detection stack below). */
struct ScrJsonSeenEnt;
typedef struct {
  char *data;
  size_t len;
  size_t cap;
  /* Circular-structure detection for RECURSIVE record types (cyclic
   * values must throw Node's exact TypeError, never recurse forever):
   * the stack of container values currently being serialized, each with
   * its outgoing edge label (the member being written). Only walkers over
   * cycle-CAPABLE types (the collector-fixpoint set) maintain it; acyclic
   * types keep the zero-cost path. */
  struct ScrJsonSeenEnt *seen;
  size_t seen_len;
  size_t seen_cap;
} ScrJsonBuf;
/* Emitted JSON writers append constant text inline (llvm/walkers.ts
 * appendBytes) through this prefix. */
_Static_assert(offsetof(ScrJsonBuf, data) == 0 && offsetof(ScrJsonBuf, len) == sizeof(char *) &&
                   offsetof(ScrJsonBuf, cap) == sizeof(char *) + sizeof(size_t),
               "LLVM backend expects ScrJsonBuf to start with { data, len, cap }");

void scr_jb_init(ScrJsonBuf *b);
/* Append a borrowed byte span verbatim, including embedded NUL bytes. */
void scr_jb_write(ScrJsonBuf *b, const char *s, size_t n);
/* scr_jb_write for text that holds no lone surrogate (fixed text, JSON
 * tokens), which cannot complete a surrogate pair at the seam. */
void scr_jb_write_utf8(ScrJsonBuf *b, const char *s, size_t n);
/* Append one borrowed runtime string verbatim (no JSON quoting). */
void scr_jb_put_str(ScrJsonBuf *b, const ScrStr *s);
/* Push a container onto the circular-detection stack before serializing
 * its members. If `v` is already ON the stack, throws V8's exact
 * "Converting circular structure to JSON" TypeError (the --> starting at /
 * |property/index hops/--- closes the circle rendering, ellipsis rules
 * included) and returns false — the caller returns immediately; the
 * emitted stringify site runs the pending check. `is_array` picks the
 * constructor name in the message ('Array' for arrays AND tuple shapes —
 * their JS values are arrays — 'Object' for records). */
bool scr_jb_enter(ScrJsonBuf *b, const void *v, bool is_array);
void scr_jb_leave(ScrJsonBuf *b);
/* Record the edge currently being serialized on the stack top: a static
 * property name (emitted C literal), an overflow key (borrowed for the
 * duration of the member write), or an array/tuple index. */
void scr_jb_edge_prop(ScrJsonBuf *b, const char *name);
void scr_jb_edge_key(ScrJsonBuf *b, const ScrStr *key);
void scr_jb_edge_idx(ScrJsonBuf *b, size_t i);

/* Circular guard for the compiler-emitted typed→dyn converters (sc_td_*
 * over cycle-capable containers): enter TRAPS on a value already being
 * converted (a cyclic value has no finite dyn copy — Node shares the
 * reference instead; SEMANTICS.md), else pushes. */
void scr_dyn_from_enter(const void *v);
void scr_dyn_from_leave(void);
void scr_jb_putc(ScrJsonBuf *b, char c);
void scr_jb_puts(ScrJsonBuf *b, const char *s);
/* JS JSON.stringify number rules: NaN/±Infinity → null, -0 → 0, else
 * shortest-roundtrip via scr_f64_to_str. */
void scr_jb_put_f64(ScrJsonBuf *b, double v);
/* Append String(number), including NaN/Infinity, without a temporary string. */
void scr_jb_put_number(ScrJsonBuf *b, double v);
/* Quoted + escaped JSON string: \" \\ \n \r \t \b \f, other control chars
 * as \u00XX, lone surrogates as \udXXX, everything else (UTF-8 included)
 * verbatim — exactly the JS JSON.stringify escape set. */
void scr_jb_put_json_str(ScrJsonBuf *b, const ScrStr *s);

/* JSON-serialize a dyn value into the buffer — the sc_jw_* walker for the
 * dyn leaves the compiler cannot type: object members holding undefined
 * DROP, array slots holding undefined print null (exactly Node). */
void scr_jb_put_dyn(ScrJsonBuf *b, const ScrDyn *d);
ScrStr *scr_jb_finish(ScrJsonBuf *b); /* returns +1; frees the buffer */
/* Reformat compiler-produced compact JSON with an already resolved gap.
 * Borrows both inputs; gap_len is a byte length, including embedded NUL.
 * Returns a new owned string, or retains compact when the gap is empty. */
ScrStr *scr_json_indent(const ScrStr *compact, const char *gap, size_t gap_len);

#endif /* SCR_JSON_H */

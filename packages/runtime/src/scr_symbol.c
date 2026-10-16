/* ES Symbol values (scr_runtime.h has the API contract): a runtime-unique
 * identity value — the POINTER is the identity, so `Symbol('a') ===
 * Symbol('a')` is false and a symbol equals exactly itself, JS's spec
 * without approximation. A symbol owns at most a description string and
 * (for Symbol.for symbols) its registry key: pure immutable data, never
 * part of a cycle, no trace header.
 *
 * The Symbol.for registry is the spec's GlobalSymbolRegistry: one symbol
 * per key (byte equality), never evicted for the program's lifetime. The
 * chain is intrusive (reg_next) and holds one reference per entry; the
 * atexit cleanup releases the chain — registered at FIRST use, which is
 * always after scr_init registered the RC audit, so atexit's LIFO order
 * runs it before the audit and the audited string counts stay exact. */
#include "scr_runtime.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

struct ScrSym {
  size_t rc;
  ScrStr *desc;    /* owned; NULL = no description (Symbol()) */
  ScrStr *reg_key; /* owned; non-NULL exactly for Symbol.for symbols */
  struct ScrSym *reg_next; /* the registry's intrusive chain */
};

ScrSym *scr_sym_retain(ScrSym *s) {
  if (s->rc != SIZE_MAX) s->rc++;
  return s;
}

void scr_sym_release(ScrSym *s) {
  if (!s || s->rc == SIZE_MAX) return;
  if (--s->rc == 0) {
    scr_str_release(s->desc);
    scr_str_release(s->reg_key);
    free(s);
  }
}

void *scr_sym_retain_v(void *p) { return scr_sym_retain(p); }
void scr_sym_release_v(void *p) { scr_sym_release(p); }

ScrSym *scr_sym_new(ScrStr *desc) {
  ScrSym *s = malloc(sizeof(ScrSym));
  if (!s) {
    scr_trap("scriptc: out of memory\n");
  }
  s->rc = 1;
  s->desc = desc ? scr_str_retain(desc) : NULL;
  s->reg_key = NULL;
  s->reg_next = NULL;
  return s;
}

/* ── the Symbol.for global registry ──────────────────────────────────── */

static SCR_TL ScrSym *g_sym_registry = NULL;
static SCR_TL ScrSym *g_sym_well_known = NULL;

static void scr_sym_well_known_cleanup(void) {
  while (g_sym_well_known) {
    ScrSym *symbol = g_sym_well_known;
    g_sym_well_known = symbol->reg_next;
    scr_sym_release(symbol);
  }
}

ScrSym *scr_sym_well_known(ScrStr *name) {
  ScrStr *prefix = scr_str_new("Symbol.", 7);
  ScrStr *description = scr_str_concat(prefix, name);
  scr_str_release(prefix);
  for (ScrSym *symbol = g_sym_well_known; symbol; symbol = symbol->reg_next) {
    if (!scr_str_eq(description, symbol->desc)) continue;
    scr_str_release(description);
    return scr_sym_retain(symbol);
  }
  if (!g_sym_well_known) scr_atexit(scr_sym_well_known_cleanup);
  ScrSym *symbol = scr_sym_new(description);
  scr_str_release(description);
  symbol->reg_next = g_sym_well_known;
  g_sym_well_known = scr_sym_retain(symbol);
  if (name->len == 8 && !memcmp(name->data, "iterator", 8)) {
    ScrDyn *key = scr_dyn_new_symbol(symbol);
    scr_dyn_install_iterator_symbol(key);
    scr_dyn_release(key);
  }
  if (name->len == 13 && !memcmp(name->data, "asyncIterator", 13)) {
    ScrDyn *key = scr_dyn_new_symbol(symbol);
    scr_dyn_install_async_iterator_symbol(key);
    scr_dyn_release(key);
  }
  if (name->len == 11 && !memcmp(name->data, "toPrimitive", 11)) {
    ScrDyn *key = scr_dyn_new_symbol(symbol);
    scr_dyn_install_to_primitive_symbol(key);
    scr_dyn_release(key);
  }
  return symbol;
}

static void scr_sym_registry_cleanup(void) {
  ScrSym *s = g_sym_registry;
  g_sym_registry = NULL;
  while (s) {
    ScrSym *next = s->reg_next;
    scr_sym_release(s);
    s = next;
  }
}

ScrSym *scr_sym_for(ScrStr *key) {
  for (ScrSym *s = g_sym_registry; s; s = s->reg_next) {
    if (scr_str_eq(s->reg_key, key)) return scr_sym_retain(s);
  }
  /* First request for this key: a fresh symbol whose description IS the
   * key (the spec's Symbol.for behavior), chained into the registry with
   * the registry's own reference. */
  if (!g_sym_registry) scr_atexit(scr_sym_registry_cleanup);
  ScrSym *s = scr_sym_new(key);
  s->reg_key = scr_str_retain(key);
  s->reg_next = g_sym_registry;
  g_sym_registry = scr_sym_retain(s);
  return s;
}

ScrStr *scr_sym_desc(ScrSym *s) { return s->desc ? scr_str_retain(s->desc) : NULL; }

ScrStr *scr_sym_key_for(ScrSym *s) { return s->reg_key ? scr_str_retain(s->reg_key) : NULL; }

ScrDyn *scr_dyn_new_symbol(ScrSym *value) {
  return scr_dyn_symbol_ref(scr_sym_retain(value), scr_sym_release, scr_sym_to_string, scr_sym_desc);
}

ScrStr *scr_sym_to_string(ScrSym *s) {
  /* "Symbol(desc)" — Symbol.prototype.toString: an absent description
   * prints as the empty parenthesis pair ("Symbol()"), exactly Node
   * (Symbol() and Symbol(undefined) alike). */
  size_t dlen = s->desc ? s->desc->len : 0;
  size_t len = 7 + dlen + 1; /* "Symbol(" + desc + ")" */
  ScrStr *out = scr_str_alloc_raw(len, len);
  memcpy(out->data, "Symbol(", 7);
  if (dlen > 0) memcpy(out->data + 7, s->desc->data, dlen);
  out->data[7 + dlen] = ')';
  out->data[len] = '\0';
  out->len = len;
  return out;
}

/* ── assert strict equality over symbols (lives here for the same reason
 * assert.match lives in scr_regex.c: it needs the symbol rendering, and
 * every call site carries symbol values, so the symbol link switch is
 * already on; the assert switch pulls scr_assert.c alongside) ─────────
 * strictEqual IS deepStrictEqual for symbols (a primitive under
 * SameValue): pointer identity — every scr_sym_new is a distinct
 * identity, Symbol.for interns per key. Failing messages are v24's
 * string-style forms over the "Symbol(desc)" rendering: symbols take the
 * stacked diff with the first-difference `^` indicator (the shared
 * "Symbol(" prefix keeps the indicator past the i >= 3 skip; equal
 * renderings of distinct symbols print the +/- pair with no indicator),
 * and never the 12-char short form ("Symbol()" twice is already 16). */
void scr_assert_eq_sym(ScrSym *a, ScrSym *b, bool negated, bool deep,
                       ScrStr *msg, bool has_msg) {
  bool same = a == b;
  if ((negated && !same) || (!negated && same)) return;
  scr_assert_record(scr_dyn_new_symbol(a), scr_dyn_new_symbol(b), scr_assert_eq_operator(negated, deep));
  ScrStr *ia = scr_sym_to_string(a);
  if (negated) {
    scr_assert_neq_fail(ia->data, ia->len, deep, msg, has_msg);
    scr_str_release(ia);
    return;
  }
  ScrStr *ib = scr_sym_to_string(b);
  scr_assert_eq_fail(ia->data, ia->len, ib->data, ib->len, 0, false, true, deep,
                     msg, has_msg);
  scr_str_release(ia);
  scr_str_release(ib);
}

/* Symbol-keyed globals share the symbol unit's link gate. The always-linked
 * JSON unit must not depend on optional symbol retain/release functions. */
typedef struct ScrGlobalSymbolProperty {
  ScrSym *key;
  ScrDyn *value;
  struct ScrGlobalSymbolProperty *next;
} ScrGlobalSymbolProperty;

static SCR_TL ScrGlobalSymbolProperty *scr_global_symbols = NULL;
static SCR_TL bool scr_global_symbols_cleanup_registered = false;

static void scr_global_symbols_cleanup(void) {
  while (scr_global_symbols) {
    ScrGlobalSymbolProperty *entry = scr_global_symbols;
    scr_global_symbols = entry->next;
    scr_sym_release(entry->key);
    scr_dyn_release(entry->value);
    free(entry);
  }
}

ScrDyn *scr_dyn_global_symbol_get(ScrSym *key) {
  for (ScrGlobalSymbolProperty *entry = scr_global_symbols; entry; entry = entry->next) {
    if (entry->key == key) return scr_dyn_retain(entry->value);
  }
  return scr_dyn_retain(scr_dyn_undefined());
}

void scr_dyn_global_symbol_set(ScrSym *key, ScrDyn *value) {
  for (ScrGlobalSymbolProperty *entry = scr_global_symbols; entry; entry = entry->next) {
    if (entry->key != key) continue;
    ScrDyn *previous = entry->value;
    entry->value = scr_dyn_retain(value);
    scr_dyn_release(previous);
    return;
  }
  if (!scr_global_symbols_cleanup_registered) {
    scr_atexit(scr_global_symbols_cleanup);
    scr_global_symbols_cleanup_registered = true;
  }
  ScrGlobalSymbolProperty *entry = malloc(sizeof *entry);
  if (!entry) scr_trap("scriptc: out of memory\n");
  entry->key = scr_sym_retain(key);
  entry->value = scr_dyn_retain(value);
  entry->next = scr_global_symbols;
  scr_global_symbols = entry;
}

bool scr_dyn_global_symbol_has(ScrSym *key) {
  for (ScrGlobalSymbolProperty *entry = scr_global_symbols; entry; entry = entry->next) {
    if (entry->key == key) return true;
  }
  return false;
}

void scr_dyn_global_symbol_delete(ScrSym *key) {
  ScrGlobalSymbolProperty **slot = &scr_global_symbols;
  while (*slot) {
    ScrGlobalSymbolProperty *entry = *slot;
    if (entry->key != key) { slot = &entry->next; continue; }
    *slot = entry->next;
    scr_sym_release(entry->key);
    scr_dyn_release(entry->value);
    free(entry);
    return;
  }
}

/* ── fs.Dirent as a dynamic value ────────────────────────────────────
 * A Dirent row converted to dyn (untyped JavaScript, `unknown` slots)
 * takes Node's shape: own enumerable name and parentPath, the entry kind
 * under an own enumerable Symbol(type) key, and the type probes on a
 * shared Dirent prototype as non-enumerable methods. The %dtype field
 * stays an own, non-enumerable property so a dyn Dirent converts back to
 * the typed row. It lives in this unit because the Symbol(type) key needs
 * it; the compiler links the unit whenever the program has the Dirent
 * record shape. */
static SCR_TL ScrDyn *scr_dirent_prototype;
static SCR_TL ScrDyn *scr_dirent_type_key;
static SCR_TL ScrStr *scr_dirent_type_storage;

static ScrDyn *scr_dirent_probe(double code) {
  ScrDyn *self = scr_dyn_this_get();
  ScrDyn *view = self->kind == SCR_DYN_TYPED_REF ? scr_dyn_typed_ref_materialize(self) : scr_dyn_retain(self);
  scr_dyn_release(self);
  if (scr_exc_pending()) {
    scr_dyn_release(view);
    return NULL;
  }
  if (view->kind == SCR_DYN_UNDEF || view->kind == SCR_DYN_NULL) {
    char message[64];
    int n = snprintf(message, sizeof message, "Cannot read properties of %s (reading 'Symbol(type)')",
                     view->kind == SCR_DYN_UNDEF ? "undefined" : "null");
    scr_dyn_release(view);
    scr_throw_error_msg(SCR_ERR_TYPE, message, (size_t)n);
    return NULL;
  }
  const ScrDyn *kind = view->kind == SCR_DYN_OBJ ? scr_dyn_obj_get(view, "%dtype", 6) : NULL;
  bool match = kind && kind->kind == SCR_DYN_NUM && kind->v.num == code;
  scr_dyn_release(view);
  return scr_dyn_new_bool(match);
}

#define SCR_DIRENT_PROBE(name, code)                                                  \
  static ScrDyn *scr_dirent_##name(ScrClosure *closure, ScrDyn *const *args, size_t argc) { \
    (void)closure;                                                                    \
    (void)args;                                                                       \
    (void)argc;                                                                       \
    return scr_dirent_probe(code);                                                    \
  }
SCR_DIRENT_PROBE(isDirectory, 2)
SCR_DIRENT_PROBE(isFile, 1)
SCR_DIRENT_PROBE(isBlockDevice, 7)
SCR_DIRENT_PROBE(isCharacterDevice, 6)
SCR_DIRENT_PROBE(isSymbolicLink, 3)
SCR_DIRENT_PROBE(isFIFO, 4)
SCR_DIRENT_PROBE(isSocket, 5)
#undef SCR_DIRENT_PROBE

static void scr_dirent_teardown(void) {
  if (scr_dirent_prototype) {
    scr_dirent_prototype->v.obj.class_name = NULL;
    scr_dyn_release(scr_dirent_prototype);
    scr_dirent_prototype = NULL;
  }
  scr_dyn_release(scr_dirent_type_key);
  scr_dirent_type_key = NULL;
  scr_str_release(scr_dirent_type_storage);
  scr_dirent_type_storage = NULL;
}

static void scr_dirent_init(void) {
  if (scr_dirent_prototype) return;
  /* Node's class body order. */
  static const struct {
    const char *name;
    ScrDynThunk thunk;
  } methods[] = {
      {"isDirectory", scr_dirent_isDirectory},
      {"isFile", scr_dirent_isFile},
      {"isBlockDevice", scr_dirent_isBlockDevice},
      {"isCharacterDevice", scr_dirent_isCharacterDevice},
      {"isSymbolicLink", scr_dirent_isSymbolicLink},
      {"isFIFO", scr_dirent_isFIFO},
      {"isSocket", scr_dirent_isSocket},
  };
  ScrDyn *proto = scr_dyn_new_obj();
  proto->v.obj.class_name = "Dirent";
  for (size_t i = 0; i < sizeof methods / sizeof methods[0]; i++) {
    scr_dyn_obj_set(proto, methods[i].name, strlen(methods[i].name),
                    scr_dyn_new_func(scr_closure_new(NULL, 0), methods[i].thunk, 0, "native:fs.Dirent",
                                     methods[i].name));
    proto->v.obj.entries[proto->v.obj.len - 1].enumerable = false;
  }
  ScrStr *desc = scr_str_new("type", 4);
  ScrSym *sym = scr_sym_new(desc);
  scr_str_release(desc);
  scr_dirent_type_key = scr_dyn_new_symbol(sym);
  scr_sym_release(sym);
  scr_dirent_type_storage = scr_dyn_symbol_storage_name(scr_dirent_type_key);
  scr_dirent_prototype = proto;
  scr_atexit(scr_dirent_teardown);
}

void scr_dyn_dirent_finish(ScrDyn *obj) {
  scr_dirent_init();
  scr_dyn_release(obj->prototype);
  obj->prototype = scr_dyn_retain(scr_dirent_prototype);
  for (size_t i = 0; i < obj->v.obj.len; i++) {
    ScrDynEntry *ent = &obj->v.obj.entries[i];
    if (ent->key_len != 6 || memcmp(ent->key, "%dtype", 6) != 0) continue;
    ent->enumerable = false;
    if (!obj->symbol_properties && !obj->symbol_keys)
      scr_dyn_symbol_init_own(obj, scr_dirent_type_key, scr_dirent_type_storage, ent->value);
    else
      scr_dyn_symbol_key_set(obj, scr_dirent_type_key, ent->value);
    break;
  }
}

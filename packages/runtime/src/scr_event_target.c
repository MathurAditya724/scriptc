/* EventTarget, Event and CustomEvent over checked-dynamic values — Node's
 * lib/internal/event_target.js, step for step (scr_runtime.h has the
 * layout contract).
 *
 * Listeners for one event type form a linked list in registration order.
 * Every node holds a reference on its `next` node and keeps that link when
 * it is removed, exactly the JS objects Node walks: a dispatch caches the
 * next node before a callback runs, skips nodes flagged removed, and
 * continues from a removed node into whatever it last pointed at. Type
 * roots are refcounted the same way, so a dispatch keeps walking a root
 * that removeEventListener dropped from the target's map.
 */
#include "scr_runtime.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef _WIN32
#include <process.h>
#define SCR_ET_PID() ((long)_getpid())
#else
#include <unistd.h>
#define SCR_ET_PID() ((long)getpid())
#endif

enum {
  SCR_ET_ONCE = 1 << 0,
  SCR_ET_CAPTURE = 1 << 1,
  SCR_ET_PASSIVE = 1 << 2,
  SCR_ET_RESIST = 1 << 3, /* runs after stopImmediatePropagation */
  SCR_ET_REMOVED = 1 << 4,
};

typedef struct ScrEtListener ScrEtListener;

struct ScrEtListener {
  size_t rc;
  ScrEtListener *next; /* +1 */
  ScrEtListener *prev; /* weak; NULL when the root is the predecessor */
  ScrEtRoot *root;     /* weak; the root outlives its live nodes */
  unsigned flags;
  ScrDyn *listener;    /* +1; NULL for a native listener */
  /* Native listeners: options.signal removal hooks and `on<type>`
   * attribute wrappers. */
  void (*native)(void *ctx, ScrDyn *self, ScrDyn *event);
  void *ctx;
  void (*ctx_release)(void *ctx);
};

struct ScrEtRoot {
  size_t rc;
  ScrEventTargetCore *core; /* weak; NULL once the root leaves the map */
  ScrEtRoot *map_next;      /* the map's own reference order */
  ScrStr *type;
  size_t size;
  bool resist;
  ScrEtListener *head; /* +1 */
};

struct ScrEtHandler {
  size_t rc;
  ScrStr *type;
  ScrDyn *handler; /* +1 or NULL (null) */
  ScrEtHandler *next;
};

/* `signal.addEventListener('abort', () => this.removeEventListener(type,
 * listener, options), { once: true, [kWeakHandler]: this, ... })`: the
 * signal's listener list owns the hook; the target is weak (its core
 * clears `target` when it is dropped). */
struct ScrEtHook {
  size_t rc;
  ScrEventTargetCore *target; /* weak */
  ScrEtHook *target_next;     /* the target's hook registry */
  ScrDyn *type;     /* +1, converted when the hook fires (Node's order) */
  ScrDyn *listener; /* +1 */
  bool capture;
};

static void scr_et_oom(void) {
  fputs("scriptc: out of memory\n", stderr);
  abort();
}

static void *scr_et_calloc(size_t n) {
  void *p = calloc(1, n);
  if (!p) scr_et_oom();
  return p;
}

static bool scr_et_eq(const ScrStr *s, const char *want) {
  return s->len == strlen(want) && memcmp(s->data, want, s->len) == 0;
}

static void scr_et_type_error(const char *message, const char *code) {
  scr_throw_error_msg_code(SCR_ERR_TYPE, message, strlen(message), code);
}

/* ── teardown registries ─────────────────────────────────────────────
 * Listener closures and events can reach their targets again (a closure
 * capturing the target, an event's target), cycles the RC scheme does not
 * collect. Cores with listeners and events holding references register
 * here, and exit drops them before the RC audit counts. */

static SCR_TL ScrEventTargetCore *scr_et_live_cores;
static SCR_TL ScrEvent *scr_et_live_events;
static SCR_TL bool scr_et_teardown_registered;

static void scr_et_teardown(void);

static void scr_et_register_teardown(void) {
  if (scr_et_teardown_registered) return;
  scr_et_teardown_registered = true;
  scr_atexit(scr_et_teardown);
}

static void scr_et_core_track(ScrEventTargetCore *core) {
  if (core->tracked) return;
  scr_et_register_teardown();
  core->tracked = true;
  core->tracked_prev = NULL;
  core->tracked_next = scr_et_live_cores;
  if (scr_et_live_cores) scr_et_live_cores->tracked_prev = core;
  scr_et_live_cores = core;
}

static void scr_et_core_untrack(ScrEventTargetCore *core) {
  if (!core->tracked) return;
  if (core->tracked_prev) core->tracked_prev->tracked_next = core->tracked_next;
  else scr_et_live_cores = core->tracked_next;
  if (core->tracked_next) core->tracked_next->tracked_prev = core->tracked_prev;
  core->tracked = false;
  core->tracked_prev = core->tracked_next = NULL;
}

static void scr_event_track(ScrEvent *ev) {
  if (ev->tracked) return;
  scr_et_register_teardown();
  ev->tracked = true;
  ev->tracked_prev = NULL;
  ev->tracked_next = scr_et_live_events;
  if (scr_et_live_events) scr_et_live_events->tracked_prev = ev;
  scr_et_live_events = ev;
}

static void scr_event_untrack(ScrEvent *ev) {
  if (!ev->tracked) return;
  if (ev->tracked_prev) ev->tracked_prev->tracked_next = ev->tracked_next;
  else scr_et_live_events = ev->tracked_next;
  if (ev->tracked_next) ev->tracked_next->tracked_prev = ev->tracked_prev;
  ev->tracked = false;
  ev->tracked_prev = ev->tracked_next = NULL;
}

/* ── listener nodes and type roots ─────────────────────────────────── */

static ScrEtListener *scr_et_listener_retain(ScrEtListener *l) {
  if (l) l->rc++;
  return l;
}

static void scr_et_listener_release(ScrEtListener *l) {
  while (l && --l->rc == 0) {
    ScrEtListener *next = l->next;
    scr_dyn_release(l->listener);
    if (l->ctx_release) l->ctx_release(l->ctx);
    free(l);
    l = next; /* the reference this node held */
  }
}

static ScrEtRoot *scr_et_root_retain(ScrEtRoot *r) {
  r->rc++;
  return r;
}

static void scr_et_root_release(ScrEtRoot *r) {
  if (!r || --r->rc > 0) return;
  scr_et_listener_release(r->head);
  scr_str_release(r->type);
  free(r);
}

/* Listener.remove(): unlink, keep `next`, flag removed. */
static void scr_et_listener_remove(ScrEtListener *l) {
  ScrEtListener *next = l->next;
  if (next) next->prev = l->prev;
  l->flags |= SCR_ET_REMOVED;
  /* The predecessor's link may be the last reference to l. */
  if (l->prev) {
    l->prev->next = scr_et_listener_retain(next);
  } else if (l->root) {
    l->root->head = scr_et_listener_retain(next);
  } else {
    return;
  }
  scr_et_listener_release(l);
}

static ScrEtRoot *scr_et_root_find(const ScrEventTargetCore *core, const ScrStr *type) {
  for (ScrEtRoot *r = core->roots; r; r = r->map_next) {
    if (r->type->len == type->len && memcmp(r->type->data, type->data, type->len) == 0) return r;
  }
  return NULL;
}

/* this[kEvents].delete(type) */
static void scr_et_root_unmap(ScrEventTargetCore *core, ScrEtRoot *root) {
  for (ScrEtRoot **at = &core->roots; *at; at = &(*at)->map_next) {
    if (*at == root) {
      *at = root->map_next;
      root->map_next = NULL;
      root->core = NULL;
      scr_et_root_release(root);
      return;
    }
  }
}

/* ── options.signal hooks ──────────────────────────────────────────── */

static void scr_et_hook_release(void *ctx) {
  ScrEtHook *h = ctx;
  if (--h->rc > 0) return;
  if (h->target) {
    for (ScrEtHook **at = &h->target->hooks; *at; at = &(*at)->target_next) {
      if (*at == h) {
        *at = h->target_next;
        break;
      }
    }
  }
  scr_dyn_release(h->type);
  scr_dyn_release(h->listener);
  free(h);
}

static void scr_et_remove_matching(ScrEventTargetCore *core, const ScrStr *type,
                                   const ScrDyn *listener, bool capture);
static int scr_et_listener_check(const ScrDyn *listener);
static void scr_et_report(ScrCaught *caught);

static void scr_et_hook_fire(void *ctx, ScrDyn *self, ScrDyn *event) {
  (void)self;
  (void)event;
  ScrEtHook *h = ctx;
  if (!h->target || scr_et_listener_check(h->listener) <= 0) {
    if (scr_exc_pending()) scr_et_report(scr_exc_take());
    return;
  }
  ScrStr *type = scr_dyn_string_coerce_js(h->type);
  if (!type) {
    scr_et_report(scr_exc_take());
    return;
  }
  scr_et_remove_matching(h->target, type, h->listener, h->capture);
  scr_str_release(type);
}

/* ── listener values ───────────────────────────────────────────────── */

/* validateEventListener: true for a function or an object (handleEvent is
 * read at dispatch), false for null/undefined, a TypeError otherwise. */
static int scr_et_listener_check(const ScrDyn *listener) {
  switch (listener->kind) {
  case SCR_DYN_UNDEF:
  case SCR_DYN_NULL:
    return 0;
  case SCR_DYN_FUNC:
  case SCR_DYN_OBJ:
  case SCR_DYN_ARR:
  case SCR_DYN_BYTES:
  case SCR_DYN_HANDLE:
  case SCR_DYN_PROMISE:
  case SCR_DYN_PROXY:
    return 1;
  case SCR_DYN_TYPED_REF:
    if (scr_dyn_ref_typeof_is(listener, "function") || scr_dyn_ref_typeof_is(listener, "object"))
      return 1;
    break;
  default:
    break;
  }
  scr_dyn_arg_type_fail("listener", "an instance of EventListener", listener);
  return -1;
}

static bool scr_et_listener_same(const ScrDyn *a, const ScrDyn *b) {
  return scr_dyn_strict_eq(a, b) || scr_dyn_obj_same_source(a, b);
}

/* ── the warnings Node prints through process.emitWarning ───────────── */

static SCR_TL bool scr_et_trace_hint_shown;

typedef struct {
  char name[48];
  ScrStr *message;
} ScrEtWarning;

static void *scr_et_warning_retain_v(void *p) { return p; }
static void scr_et_warning_release_v(void *p) {
  ScrEtWarning *w = p;
  scr_str_release(w->message);
  free(w);
}

static void scr_et_warn_tick(ScrClosure *cb) {
  ScrEtWarning *w = scr_box_get_ref(cb->caps[0]);
  if (scr_warning_emit_hook) {
    scr_warning_emit_hook(w->name, NULL, w->message);
    return;
  }
  fflush(stdout);
  fprintf(stderr, "(node:%ld) %s: %.*s\n", SCR_ET_PID(), w->name, (int)w->message->len,
          w->message->data);
  if (!scr_et_trace_hint_shown) {
    scr_et_trace_hint_shown = true;
    fputs("(Use `node --trace-warnings ...` to show where the warning was created)\n", stderr);
  }
}

/* process.emitWarning: listeners and the default report run from a
 * nextTick. */
static void scr_et_warn(const char *name, const char *message) {
  ScrEtWarning *w = scr_et_calloc(sizeof *w);
  snprintf(w->name, sizeof w->name, "%s", name);
  w->message = scr_str_new(message, strlen(message));
  ScrClosure *cb = scr_closure_new((void *)&scr_et_warn_tick, 1);
  cb->caps[0] = scr_box_new_obj(&scr_et_warning_retain_v, &scr_et_warning_release_v, NULL);
  scr_box_set_ref(cb->caps[0], w);
  scr_next_tick(cb);
}

/* this[kNewListener]: the one-time leak warning. */
static void scr_et_new_listener(ScrEventTargetCore *core, ScrEtRoot *root) {
  if (core->max_listeners <= 0 || (double)root->size <= core->max_listeners || core->warned) return;
  core->warned = true;
  char message[512];
  snprintf(message, sizeof message,
           "Possible EventTarget memory leak detected. %zu %.*s listeners added to %s. "
           "MaxListeners is %g. Use events.setMaxListeners() to increase limit",
           root->size, (int)root->type->len, root->type->data, core->cls, core->max_listeners);
  scr_et_warn("MaxListenersExceededWarning", message);
}

/* ── the core ──────────────────────────────────────────────────────── */

void scr_et_core_init(ScrEventTargetCore *core, double max_listeners, const char *cls) {
  memset(core, 0, sizeof *core);
  core->max_listeners = max_listeners;
  core->cls = cls;
}

void scr_et_core_drop(ScrEventTargetCore *core) {
  scr_et_core_untrack(core);
  ScrEtRoot *roots = core->roots;
  ScrEtHandler *handlers = core->handlers;
  core->roots = NULL;
  core->handlers = NULL;
  /* Hooks aimed at this target stay registered on their signals and do
   * nothing once fired (Node's weak handler). */
  while (core->hooks) {
    ScrEtHook *h = core->hooks;
    core->hooks = h->target_next;
    h->target = NULL;
    h->target_next = NULL;
  }
  while (roots) {
    ScrEtRoot *next = roots->map_next;
    roots->core = NULL;
    roots->map_next = NULL;
    scr_et_root_release(roots);
    roots = next;
  }
  while (handlers) {
    ScrEtHandler *next = handlers->next;
    handlers->next = NULL;
    if (--handlers->rc == 0) {
      scr_str_release(handlers->type);
      scr_dyn_release(handlers->handler);
      free(handlers);
    } else {
      /* A wrapper still on a dispatch's stack keeps the slot; the handler
       * value goes now so no cycle survives teardown. */
      ScrDyn *handler = handlers->handler;
      handlers->handler = NULL;
      scr_dyn_release(handler);
    }
    handlers = next;
  }
}

/* Appends a listener node to the type's list (Node's addEventListener
 * tail). `listener` borrowed (retained in); for native nodes NULL. */
static ScrEtListener *scr_et_append(ScrEventTargetCore *core, ScrStr *type, ScrDyn *listener,
                                    unsigned flags, bool *duplicate) {
  *duplicate = false;
  ScrEtRoot *root = scr_et_root_find(core, type);
  bool fresh = root == NULL;
  ScrEtListener *previous = NULL;
  if (fresh) {
    root = scr_et_calloc(sizeof *root);
    root->rc = 1; /* the map's reference */
    root->core = core;
    root->type = scr_str_retain(type);
    ScrEtRoot **tail = &core->roots;
    while (*tail) tail = &(*tail)->map_next;
    *tail = root;
  } else if (listener) {
    bool capture = (flags & SCR_ET_CAPTURE) != 0;
    for (ScrEtListener *h = root->head; h; h = h->next) {
      if (h->listener && ((h->flags & SCR_ET_CAPTURE) != 0) == capture &&
          scr_et_listener_same(h->listener, listener)) {
        *duplicate = true;
        return NULL;
      }
      previous = h;
    }
  } else {
    for (ScrEtListener *h = root->head; h; h = h->next) previous = h;
  }
  ScrEtListener *l = scr_et_calloc(sizeof *l);
  l->rc = 1; /* the predecessor's link */
  l->root = root;
  l->prev = previous;
  l->flags = flags;
  l->listener = listener ? scr_dyn_retain(listener) : NULL;
  if (previous) previous->next = l;
  else root->head = l;
  root->size = fresh ? 1 : root->size + 1;
  if (flags & SCR_ET_RESIST) root->resist = true;
  scr_et_core_track(core);
  return l;
}

static void scr_et_remove_matching(ScrEventTargetCore *core, const ScrStr *type,
                                   const ScrDyn *listener, bool capture) {
  ScrEtRoot *root = scr_et_root_find(core, type);
  if (!root || !root->head) return;
  for (ScrEtListener *h = root->head; h; h = h->next) {
    if (h->listener && ((h->flags & SCR_ET_CAPTURE) != 0) == capture &&
        scr_et_listener_same(h->listener, listener)) {
      scr_et_listener_remove(h);
      root->size--;
      if (root->size == 0) scr_et_root_unmap(core, root);
      return;
    }
  }
}

/* A property read on an options dictionary: typed records cross as live
 * capsules, read through their materialized view. +1 or NULL. */
static ScrDyn *scr_et_prop(const ScrDyn *object, const char *key) {
  if (object->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *view = scr_dyn_typed_ref_materialize(object);
    ScrDyn *value = view ? scr_dyn_obj_read(view, key, strlen(key)) : NULL;
    scr_dyn_release(view);
    return value;
  }
  return scr_dyn_obj_read(object, key, strlen(key));
}

/* The listener options: a boolean is `capture`, null is no options, any
 * object's once/capture/passive/signal are read in Node's order. */
typedef struct {
  bool once, capture, passive;
  ScrDyn *signal; /* +1 or NULL */
} ScrEtOptions;

static bool scr_et_read_options(const ScrDyn *options, ScrEtOptions *out) {
  memset(out, 0, sizeof *out);
  if (!options || options->kind == SCR_DYN_UNDEF) return true;
  if (options->kind == SCR_DYN_BOOL) {
    out->capture = options->v.b;
    return true;
  }
  if (options->kind == SCR_DYN_NULL) return true;
  if (!scr_dyn_is_object(options) && options->kind != SCR_DYN_FUNC) {
    scr_dyn_arg_type_fail("options", "of type object", options);
    return false;
  }
  static const char *const keys[] = {"once", "capture", "passive"};
  bool *slots[] = {&out->once, &out->capture, &out->passive};
  for (size_t i = 0; i < 3; i++) {
    ScrDyn *v = scr_et_prop(options, keys[i]);
    if (!v && scr_exc_pending()) return false;
    *slots[i] = v && scr_dyn_truthy(v);
    scr_dyn_release(v);
  }
  ScrDyn *signal = scr_et_prop(options, "signal");
  if (!signal && scr_exc_pending()) return false;
  if (signal && signal->kind == SCR_DYN_UNDEF) {
    scr_dyn_release(signal);
    signal = NULL;
  }
  out->signal = signal;
  return true;
}

SCR_TL ScrEventTargetCore *(*scr_et_signal_core_fn)(const ScrDyn *d, bool *aborted) = NULL;

ScrDyn *scr_et_add_listener(ScrEventTargetCore *core, ScrDyn *const *args, size_t argc) {
  if (argc < 2) {
    scr_et_type_error("The \"type\" and \"listener\" arguments must be specified", "ERR_MISSING_ARGS");
    return NULL;
  }
  ScrEtOptions opts;
  if (!scr_et_read_options(argc > 2 ? args[2] : NULL, &opts)) return NULL;
  if (opts.signal) {
    bool aborted = false;
    ScrEventTargetCore *signal_core =
        scr_et_signal_core_fn ? scr_et_signal_core_fn(opts.signal, &aborted) : NULL;
    if (!signal_core) {
      scr_dyn_prop_type_fail("options.signal", "an instance of AbortSignal", opts.signal);
      scr_dyn_release(opts.signal);
      return NULL;
    }
    scr_dyn_release(opts.signal);
    if (aborted) return scr_dyn_retain(scr_dyn_undefined());
    ScrEtHook *h = scr_et_calloc(sizeof *h);
    h->rc = 1;
    h->type = scr_dyn_retain(args[0]);
    h->listener = scr_dyn_retain(args[1]);
    h->capture = opts.capture;
    h->target = core;
    h->target_next = core->hooks;
    core->hooks = h;
    ScrStr *abort = scr_str_new("abort", 5);
    bool duplicate;
    ScrEtListener *l =
        scr_et_append(signal_core, abort, NULL, SCR_ET_ONCE | SCR_ET_RESIST, &duplicate);
    scr_str_release(abort);
    l->native = scr_et_hook_fire;
    l->ctx = h; /* the creation reference moves in */
    l->ctx_release = scr_et_hook_release;
  }
  int valid = scr_et_listener_check(args[1]);
  if (valid < 0) return NULL;
  if (valid == 0) {
    char message[96];
    snprintf(message, sizeof message, "addEventListener called with %s which has no effect.",
             args[1]->kind == SCR_DYN_NULL ? "null" : "undefined");
    scr_et_warn("AddEventListenerArgumentTypeWarning", message);
    return scr_dyn_retain(scr_dyn_undefined());
  }
  ScrStr *type = scr_dyn_string_coerce_js(args[0]);
  if (!type) return NULL;
  unsigned flags = (opts.once ? SCR_ET_ONCE : 0) | (opts.capture ? SCR_ET_CAPTURE : 0) |
                   (opts.passive ? SCR_ET_PASSIVE : 0);
  bool duplicate;
  ScrEtListener *l = scr_et_append(core, type, args[1], flags, &duplicate);
  if (l) scr_et_new_listener(core, l->root);
  scr_str_release(type);
  return scr_dyn_retain(scr_dyn_undefined());
}

ScrDyn *scr_et_remove_listener(ScrEventTargetCore *core, ScrDyn *const *args, size_t argc) {
  if (argc < 2) {
    scr_et_type_error("The \"type\" and \"listener\" arguments must be specified", "ERR_MISSING_ARGS");
    return NULL;
  }
  int valid = scr_et_listener_check(args[1]);
  if (valid < 0) return NULL;
  if (valid == 0) return scr_dyn_retain(scr_dyn_undefined());
  ScrStr *type = scr_dyn_string_coerce_js(args[0]);
  if (!type) return NULL;
  /* `options?.capture === true`: a boolean options value reads no
   * capture property. */
  bool capture = false;
  if (argc > 2 && scr_dyn_is_object(args[2])) {
    ScrDyn *v = scr_et_prop(args[2], "capture");
    if (!v && scr_exc_pending()) {
      scr_str_release(type);
      return NULL;
    }
    capture = v && v->kind == SCR_DYN_BOOL && v->v.b;
    scr_dyn_release(v);
  }
  scr_et_remove_matching(core, type, args[1], capture);
  scr_str_release(type);
  return scr_dyn_retain(scr_dyn_undefined());
}

/* ── listener errors ───────────────────────────────────────────────── */

static void *scr_et_caught_retain_v(void *p) { return scr_caught_retain((ScrCaught *)p); }
static void scr_et_caught_release_v(void *p) { scr_caught_release((ScrCaught *)p); }

static void scr_et_rethrow_tick(ScrClosure *cb) {
  ScrCaught *caught = scr_box_get_ref(cb->caps[0]);
  scr_rethrow(caught);
  scr_caught_release(caught);
}

/* emitUncaughtException: process.nextTick(() => { throw err; }). */
static void scr_et_report(ScrCaught *caught /* moves */) {
  ScrClosure *cb = scr_closure_new((void *)&scr_et_rethrow_tick, 1);
  cb->caps[0] = scr_box_new_obj(&scr_et_caught_retain_v, &scr_et_caught_release_v, NULL);
  scr_box_set_ref(cb->caps[0], caught);
  scr_next_tick(cb);
}

static ScrDyn *scr_et_report_call(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  (void)clo;
  scr_dyn_throw(scr_dyn_retain(argc ? args[0] : scr_dyn_undefined()));
  scr_et_report(scr_exc_take());
  return scr_dyn_retain(scr_dyn_undefined());
}

/* addCatch(result): `then(undefined, report)`. A native promise reports
 * from a continuation one turn after it rejects (the reaction's turn);
 * `awaited` adds the handleEvent wrapper's own await, one turn more. */
typedef struct {
  ScrPromise *promise;
  bool awaited;
} ScrEtCatch;

static void scr_et_report_job(ScrClosure *job) {
  ScrCaught *caught = scr_box_get_ref(job->caps[0]);
  scr_et_report(caught);
}

/* A reaction job one microtask from now that reports `caught`. */
static void scr_et_report_later(ScrCaught *caught /* moves */) {
  ScrClosure *job = scr_closure_new((void *)&scr_et_report_job, 1);
  job->caps[0] = scr_box_new_obj(&scr_et_caught_retain_v, &scr_et_caught_release_v, NULL);
  scr_box_set_ref(job->caps[0], caught);
  scr_queue_microtask(job);
}

static void scr_et_catch_entry(ScrFiber *self, void *argpack) {
  (void)self;
  ScrEtCatch *c = argpack;
  if (!scr_promise_await_settled(c->promise)) {
    ScrCaught *caught = scr_exc_take();
    if (c->awaited) scr_et_report_later(caught);
    else scr_et_report(caught);
  }
  scr_promise_release(c->promise);
  free(c);
}

static void scr_et_catch_promise(ScrPromise *p, bool awaited) {
  scr_promise_mark_handled(p);
  ScrEtCatch *c = scr_et_calloc(sizeof *c);
  c->promise = scr_promise_retain(p);
  c->awaited = awaited;
  ScrPromise *done = scr_async_spawn_after(p, scr_et_catch_entry, c);
  scr_promise_release(done);
}

static void scr_et_add_catch(ScrDyn *result) {
  if (result->kind == SCR_DYN_PROMISE) {
    scr_et_catch_promise(result->v.promise, false);
    return;
  }
  if (!scr_dyn_is_object(result) && result->kind != SCR_DYN_FUNC) return;
  ScrDyn *then = scr_dyn_obj_read(result, "then", 4);
  if (then && scr_dyn_is_callable(then)) {
    ScrDyn *report = scr_dyn_new_func(scr_closure_new((void *)&scr_et_report_call, 0),
                                      scr_et_report_call, 1, "(err)", "");
    ScrDyn *call_args[2] = {scr_dyn_undefined(), report};
    scr_dyn_this_push_dyn(result);
    ScrDyn *r = scr_dyn_call(then, call_args, 2, "then");
    scr_dyn_this_pop();
    scr_dyn_release(r);
    scr_dyn_release(report);
  }
  scr_dyn_release(then);
  if (scr_exc_pending()) scr_et_report(scr_exc_take());
}

/* The handleEvent wrapper is an async function: a synchronous throw
 * rejects its promise at once, so addCatch's reaction is the next job. */
static void scr_et_reject_through_catch(ScrCaught *caught /* moves */) {
  scr_et_report_later(caught);
}

/* Calls one listener with `this` = the target (functions) or the listener
 * object (handleEvent). */
static void scr_et_invoke(ScrEtListener *l, ScrDyn *self, ScrDyn *event) {
  if (l->native) {
    l->native(l->ctx, self, event);
    return;
  }
  ScrDyn *listener = l->listener;
  ScrDyn *args[1] = {event};
  if (listener->kind == SCR_DYN_FUNC ||
      (listener->kind == SCR_DYN_TYPED_REF && scr_dyn_ref_typeof_is(listener, "function"))) {
    scr_dyn_this_push_dyn(self);
    ScrDyn *result = scr_dyn_call(listener, args, 1, "listener");
    scr_dyn_this_pop();
    if (!result) {
      scr_et_report(scr_exc_take());
      return;
    }
    if (result->kind != SCR_DYN_UNDEF && result->kind != SCR_DYN_NULL) scr_et_add_catch(result);
    scr_dyn_release(result);
    return;
  }
  /* `if (listener.handleEvent) await ReflectApply(listener.handleEvent,
   * listener, args)`. A typed record listener re-reads its live source,
   * so handleEvent replacements on the original are seen here. */
  ScrDyn *current = listener->kind == SCR_DYN_OBJ && listener->v.obj.source_identity &&
                            listener->v.obj.source_access
                        ? listener->v.obj.source_access(listener->v.obj.source_identity, true)
                        : scr_dyn_retain(listener);
  ScrDyn *handle = NULL;
  if (current->kind == SCR_DYN_OBJ || current->kind == SCR_DYN_PROXY ||
      current->kind == SCR_DYN_TYPED_REF) {
    if (current->kind == SCR_DYN_TYPED_REF) {
      ScrDyn *view = scr_dyn_typed_ref_materialize(current);
      handle = view ? scr_dyn_obj_read(view, "handleEvent", 11) : NULL;
      scr_dyn_release(view);
    } else if (current->kind == SCR_DYN_PROXY) {
      ScrStr *key = scr_str_new("handleEvent", 11);
      handle = scr_dyn_proxy_get(current, key);
      scr_str_release(key);
    } else {
      handle = scr_dyn_obj_read(current, "handleEvent", 11);
    }
  }
  if (!handle && scr_exc_pending()) {
    scr_dyn_release(current);
    scr_et_reject_through_catch(scr_exc_take());
    return;
  }
  if (handle && scr_dyn_truthy(handle)) {
    if (!scr_dyn_is_callable(handle)) {
      /* Reflect.apply's TypeError, V8's wording. */
      bool primitive =
          handle->kind == SCR_DYN_NUM || handle->kind == SCR_DYN_STR || handle->kind == SCR_DYN_BOOL;
      ScrStr *text = primitive ? scr_dyn_string_coerce_js(handle) : scr_str_new("#<Object>", 9);
      const char *kind = handle->kind == SCR_DYN_NUM    ? "a number"
                         : handle->kind == SCR_DYN_STR  ? "a string"
                         : handle->kind == SCR_DYN_BOOL ? "a boolean"
                                                        : "an object";
      char message[320];
      snprintf(message, sizeof message,
               "Function.prototype.apply was called on %.*s, which is %s and not a function",
               text ? (int)text->len : 0, text ? text->data : "", kind);
      scr_str_release(text);
      scr_throw_error_msg(SCR_ERR_TYPE, message, strlen(message));
      scr_et_reject_through_catch(scr_exc_take());
    } else {
      ScrDyn *receiver = listener->kind == SCR_DYN_TYPED_REF ? listener : current;
      scr_dyn_this_push_dyn(receiver);
      ScrDyn *result = scr_dyn_call(handle, args, 1, "handleEvent");
      scr_dyn_this_pop();
      if (!result) {
        scr_et_reject_through_catch(scr_exc_take());
      } else {
        /* the wrapper awaits a returned promise and settles after it */
        if (result->kind == SCR_DYN_PROMISE) scr_et_catch_promise(result->v.promise, true);
        scr_dyn_release(result);
      }
    }
  }
  scr_dyn_release(handle);
  scr_dyn_release(current);
}

/* ── dispatch (kHybridDispatch) ────────────────────────────────────── */

static ScrEvent *scr_event_of(const ScrDyn *d) {
  if (d && d->kind == SCR_DYN_HANDLE &&
      (d->v.handle.tag == SCR_DYNH_EVENT || d->v.handle.tag == SCR_DYNH_CUSTOM_EVENT)) {
    return (ScrEvent *)d->v.handle.ptr;
  }
  return NULL;
}

static void scr_event_set_target(ScrEvent *ev, ScrDyn *target) {
  ScrDyn *old = ev->target;
  ev->target = scr_dyn_retain(target);
  scr_event_track(ev);
  scr_dyn_release(old);
}

void scr_et_dispatch(ScrEventTargetCore *core, ScrDyn *self, ScrDyn *event) {
  ScrEvent *ev = scr_event_of(event);
  scr_dyn_retain(event);
  scr_event_set_target(ev, self);
  ev->dispatching = true;
  ScrStr *type = scr_str_retain(ev->type);
  ScrEtRoot *root = scr_et_root_find(core, type);
  scr_str_release(type);
  if (!root || !root->head) {
    ev->dispatching = false;
    scr_dyn_release(event);
    return;
  }
  scr_et_root_retain(root);
  ScrEtListener *handler = scr_et_listener_retain(root->head);
  while (handler && (root->resist || (handler->flags & SCR_ET_PASSIVE) || !ev->stop)) {
    /* Cache the next item in case this iteration removes the current one. */
    ScrEtListener *next = scr_et_listener_retain(handler->next);
    if ((handler->flags & SCR_ET_REMOVED) || (ev->stop && !(handler->flags & SCR_ET_RESIST))) {
      scr_et_listener_release(handler);
      handler = next;
      continue;
    }
    if (handler->flags & SCR_ET_ONCE) {
      scr_et_listener_remove(handler);
      root->size--;
    }
    bool passive = (handler->flags & SCR_ET_PASSIVE) != 0;
    if (passive) ev->in_passive = true;
    scr_et_invoke(handler, self, event);
    ev->dispatching = false;
    if (ev->in_passive) ev->in_passive = false;
    scr_et_listener_release(handler);
    handler = next;
  }
  scr_et_listener_release(handler);
  ev->dispatching = false;
  scr_et_root_release(root);
  scr_dyn_release(event);
}

ScrDyn *scr_et_dispatch_event(ScrEventTargetCore *core, ScrDyn *self, ScrDyn *const *args,
                              size_t argc) {
  if (argc < 1) {
    scr_et_type_error("The \"event\" argument must be specified", "ERR_MISSING_ARGS");
    return NULL;
  }
  ScrEvent *ev = scr_event_of(args[0]);
  if (!ev) {
    scr_dyn_arg_type_fail("event", "an instance of Event", args[0]);
    return NULL;
  }
  if (ev->dispatching) {
    char message[256];
    snprintf(message, sizeof message, "The event \"%.*s\" is already being dispatched",
             (int)ev->type->len, ev->type->data);
    scr_throw_error_msg_code(SCR_ERR_ERROR, message, strlen(message), "ERR_EVENT_RECURSION");
    return NULL;
  }
  scr_et_dispatch(core, self, args[0]);
  return scr_dyn_new_bool(!(ev->cancelable && ev->default_prevented));
}

/* ── event-handler attributes (defineEventHandler) ─────────────────── */

static void scr_et_handler_release(void *ctx) {
  ScrEtHandler *h = ctx;
  if (--h->rc > 0) return;
  scr_str_release(h->type);
  scr_dyn_release(h->handler);
  free(h);
}

/* The wrapper: `if (typeof handler !== 'function') return; return
 * ReflectApply(handler, this, args)`. */
static void scr_et_handler_fire(void *ctx, ScrDyn *self, ScrDyn *event) {
  ScrEtHandler *h = ctx;
  if (!h->handler || !scr_dyn_is_callable(h->handler)) return;
  ScrDyn *handler = scr_dyn_retain(h->handler);
  ScrDyn *args[1] = {event};
  scr_dyn_this_push_dyn(self);
  ScrDyn *result = scr_dyn_call(handler, args, 1, "handler");
  scr_dyn_this_pop();
  scr_dyn_release(handler);
  if (!result) {
    scr_et_report(scr_exc_take());
    return;
  }
  if (result->kind != SCR_DYN_UNDEF && result->kind != SCR_DYN_NULL) scr_et_add_catch(result);
  scr_dyn_release(result);
}

static ScrEtHandler *scr_et_handler_find(ScrEventTargetCore *core, const char *type) {
  for (ScrEtHandler *h = core->handlers; h; h = h->next) {
    if (scr_et_eq(h->type, type)) return h;
  }
  return NULL;
}

ScrDyn *scr_et_handler_get(ScrEventTargetCore *core, const char *type) {
  ScrEtHandler *h = scr_et_handler_find(core, type);
  return h && h->handler ? scr_dyn_retain(h->handler) : scr_dyn_new_null();
}

void scr_et_handler_set(ScrEventTargetCore *core, const char *type, const ScrDyn *value) {
  ScrDyn *next =
      value->kind == SCR_DYN_NULL || value->kind == SCR_DYN_UNDEF ? NULL : scr_dyn_retain((ScrDyn *)value);
  ScrEtHandler *h = scr_et_handler_find(core, type);
  if (h) {
    /* Replacing keeps the wrapper's registration position; the listener
     * count follows whether the handler is a function. */
    ScrEtRoot *root = scr_et_root_find(core, h->type);
    bool was = h->handler && scr_dyn_is_callable(h->handler);
    bool now = next && scr_dyn_is_callable(next);
    ScrDyn *old = h->handler;
    h->handler = next;
    scr_dyn_release(old);
    if (root) {
      if (was) root->size--;
      if (now) {
        root->size++;
        scr_et_new_listener(core, root);
      }
    }
    return;
  }
  h = scr_et_calloc(sizeof *h);
  h->rc = 1; /* the core's map */
  h->type = scr_str_new(type, strlen(type));
  h->handler = next;
  h->next = core->handlers;
  core->handlers = h;
  bool duplicate;
  ScrEtListener *l = scr_et_append(core, h->type, NULL, 0, &duplicate);
  h->rc++;
  l->native = scr_et_handler_fire;
  l->ctx = h;
  l->ctx_release = scr_et_handler_release;
  scr_et_new_listener(core, l->root);
}

/* ── Event handles ─────────────────────────────────────────────────── */

static ScrEvent *scr_event_alloc(ScrStr *type /* moves */, bool custom) {
  ScrEvent *ev = scr_et_calloc(sizeof *ev);
  ev->rc = 1;
  ev->type = type;
  ev->custom = custom;
  ev->time_stamp = scr_perf_now();
  return ev;
}

static void *scr_event_retain_v(void *p) {
  ((ScrEvent *)p)->rc++;
  return p;
}

static void scr_event_drop_refs(ScrEvent *ev) {
  scr_event_untrack(ev);
  ScrDyn *target = ev->target;
  ScrDyn *detail = ev->detail;
  ev->target = NULL;
  ev->detail = NULL;
  scr_dyn_release(target);
  scr_dyn_release(detail);
}

static void scr_event_release_v(void *p) {
  ScrEvent *ev = p;
  if (--ev->rc > 0) return;
  scr_event_drop_refs(ev);
  scr_str_release(ev->type);
  free(ev);
}

static bool scr_et_key(const char *key, size_t len, const char *want) {
  return strlen(want) == len && memcmp(key, want, len) == 0;
}

static ScrDyn *scr_event_target_value(const ScrEvent *ev) {
  return ev->target ? scr_dyn_retain(ev->target) : scr_dyn_new_null();
}

static ScrDyn *scr_event_get(void *ptr, const char *key, size_t len) {
  ScrEvent *ev = ptr;
  if (scr_et_key(key, len, "type")) return scr_dyn_new_str(ev->type);
  if (scr_et_key(key, len, "target") || scr_et_key(key, len, "srcElement"))
    return scr_event_target_value(ev);
  if (scr_et_key(key, len, "currentTarget"))
    return ev->dispatching ? scr_event_target_value(ev) : scr_dyn_new_null();
  if (scr_et_key(key, len, "cancelable")) return scr_dyn_new_bool(ev->cancelable);
  if (scr_et_key(key, len, "defaultPrevented"))
    return scr_dyn_new_bool(ev->cancelable && ev->default_prevented);
  if (scr_et_key(key, len, "timeStamp")) return scr_dyn_new_num(ev->time_stamp);
  if (scr_et_key(key, len, "returnValue"))
    return scr_dyn_new_bool(!ev->cancelable || !ev->default_prevented);
  if (scr_et_key(key, len, "bubbles")) return scr_dyn_new_bool(ev->bubbles);
  if (scr_et_key(key, len, "composed")) return scr_dyn_new_bool(ev->composed);
  if (scr_et_key(key, len, "eventPhase")) return scr_dyn_new_num(ev->dispatching ? 2 : 0);
  if (scr_et_key(key, len, "cancelBubble")) return scr_dyn_new_bool(ev->propagation_stopped);
  if (scr_et_key(key, len, "isTrusted")) return scr_dyn_new_bool(ev->trusted);
  if (ev->custom && scr_et_key(key, len, "detail"))
    return ev->detail ? scr_dyn_retain(ev->detail) : scr_dyn_new_null();
  return NULL;
}

static bool scr_event_set(void *ptr, const char *key, size_t len, const ScrDyn *value) {
  ScrEvent *ev = ptr;
  if (scr_et_key(key, len, "returnValue")) {
    if (!scr_dyn_truthy(value) && ev->cancelable && !ev->in_passive) ev->default_prevented = true;
    return true;
  }
  if (scr_et_key(key, len, "cancelBubble")) {
    if (scr_dyn_truthy(value)) ev->propagation_stopped = true;
    return true;
  }
  return false;
}

static void scr_et_not_function(const char *what) {
  char message[256];
  snprintf(message, sizeof message, "%s is not a function", what);
  scr_throw_error_msg(SCR_ERR_TYPE, message, strlen(message));
}

static ScrDyn *scr_event_invoke(void *ptr, ScrDyn *self, const char *method, ScrDyn *const *args,
                                size_t argc, const char *what) {
  ScrEvent *ev = ptr;
  (void)self;
  if (strcmp(method, "preventDefault") == 0) {
    if (ev->cancelable && !ev->in_passive) ev->default_prevented = true;
    return scr_dyn_retain(scr_dyn_undefined());
  }
  if (strcmp(method, "stopPropagation") == 0) {
    ev->propagation_stopped = true;
    return scr_dyn_retain(scr_dyn_undefined());
  }
  if (strcmp(method, "stopImmediatePropagation") == 0) {
    ev->propagation_stopped = true;
    ev->stop = true;
    return scr_dyn_retain(scr_dyn_undefined());
  }
  if (strcmp(method, "composedPath") == 0) {
    ScrDyn *path = scr_dyn_new_arr();
    if (ev->dispatching) scr_dyn_arr_push(path, scr_event_target_value(ev));
    return path;
  }
  if (strcmp(method, "initEvent") == 0) {
    if (argc == 0) {
      scr_et_type_error("The \"type\" argument must be specified", "ERR_MISSING_ARGS");
      return NULL;
    }
    if (ev->dispatching) return scr_dyn_retain(scr_dyn_undefined());
    ScrStr *type = scr_dyn_string_coerce_js(args[0]);
    if (!type) return NULL;
    scr_str_release(ev->type);
    ev->type = type;
    ev->bubbles = argc > 1 && scr_dyn_truthy(args[1]);
    ev->cancelable = argc > 2 && scr_dyn_truthy(args[2]);
    return scr_dyn_retain(scr_dyn_undefined());
  }
  scr_et_not_function(what);
  return NULL;
}

/* Node's [kInspect]: `Event { type, defaultPrevented, cancelable,
 * timeStamp }`. */
static ScrDyn *scr_event_inspect_view(void *ptr) {
  ScrEvent *ev = ptr;
  ScrDyn *view = scr_dyn_new_obj();
  scr_dyn_obj_set(view, "type", 4, scr_dyn_new_str(ev->type));
  scr_dyn_obj_set(view, "defaultPrevented", 16, scr_dyn_new_bool(ev->default_prevented));
  scr_dyn_obj_set(view, "cancelable", 10, scr_dyn_new_bool(ev->cancelable));
  scr_dyn_obj_set(view, "timeStamp", 9, scr_dyn_new_num(ev->time_stamp));
  return view;
}

static const ScrDynHandleOps scr_event_ops = {
    .cls = "Event",
    .retain = scr_event_retain_v,
    .release = scr_event_release_v,
    .invoke = scr_event_invoke,
    .get = scr_event_get,
    .set = scr_event_set,
    .inspect_view = scr_event_inspect_view,
};

static const ScrDynHandleOps scr_custom_event_ops = {
    .cls = "CustomEvent",
    .retain = scr_event_retain_v,
    .release = scr_event_release_v,
    .invoke = scr_event_invoke,
    .get = scr_event_get,
    .set = scr_event_set,
    .inspect_view = scr_event_inspect_view,
};

/* ── EventTarget handles ───────────────────────────────────────────── */

typedef struct ScrEventTarget {
  size_t rc;
  ScrEventTargetCore core;
} ScrEventTarget;

static void *scr_event_target_retain_v(void *p) {
  ((ScrEventTarget *)p)->rc++;
  return p;
}

static void scr_event_target_release_v(void *p) {
  ScrEventTarget *t = p;
  if (--t->rc > 0) return;
  scr_et_core_drop(&t->core);
  free(t);
}

static ScrDyn *scr_event_target_invoke(void *ptr, ScrDyn *self, const char *method,
                                       ScrDyn *const *args, size_t argc, const char *what) {
  ScrEventTarget *t = ptr;
  if (strcmp(method, "addEventListener") == 0) return scr_et_add_listener(&t->core, args, argc);
  if (strcmp(method, "removeEventListener") == 0)
    return scr_et_remove_listener(&t->core, args, argc);
  if (strcmp(method, "dispatchEvent") == 0)
    return scr_et_dispatch_event(&t->core, self, args, argc);
  scr_et_not_function(what);
  return NULL;
}

static ScrDyn *scr_event_target_get(void *ptr, const char *key, size_t len) {
  (void)ptr;
  (void)key;
  (void)len;
  return NULL;
}

static bool scr_event_target_set(void *ptr, const char *key, size_t len, const ScrDyn *value) {
  (void)ptr;
  (void)key;
  (void)len;
  (void)value;
  return false;
}

static ScrDyn *scr_event_target_inspect_view(void *ptr) {
  (void)ptr;
  return scr_dyn_new_obj();
}

static const ScrDynHandleOps scr_event_target_ops = {
    .cls = "EventTarget",
    .retain = scr_event_target_retain_v,
    .release = scr_event_target_release_v,
    .invoke = scr_event_target_invoke,
    .get = scr_event_target_get,
    .set = scr_event_target_set,
    .inspect_view = scr_event_target_inspect_view,
};

static void scr_et_install(void) {
  static SCR_TL bool installed;
  if (installed) return;
  installed = true;
  scr_dyn_handle_install(SCR_DYNH_EVENT, &scr_event_ops);
  scr_dyn_handle_install(SCR_DYNH_CUSTOM_EVENT, &scr_custom_event_ops);
  scr_dyn_handle_install(SCR_DYNH_EVENT_TARGET, &scr_event_target_ops);
  scr_et_register_teardown();
}

static void scr_et_teardown(void) {
  while (scr_et_live_cores) scr_et_core_drop(scr_et_live_cores);
  while (scr_et_live_events) scr_event_drop_refs(scr_et_live_events);
}

ScrDyn *scr_event_target_new(void) {
  scr_et_install();
  ScrEventTarget *t = scr_et_calloc(sizeof *t);
  t->rc = 1;
  scr_et_core_init(&t->core, 10, "EventTarget");
  ScrDyn *out = scr_dyn_new_handle(t, SCR_DYNH_EVENT_TARGET);
  scr_event_target_release_v(t);
  return out;
}

ScrDyn *scr_event_new_trusted(const char *type) {
  scr_et_install();
  ScrEvent *ev = scr_event_alloc(scr_str_new(type, strlen(type)), false);
  ev->trusted = true;
  ScrDyn *out = scr_dyn_new_handle(ev, SCR_DYNH_EVENT);
  scr_event_release_v(ev);
  return out;
}

/* The constructor's options: null/undefined are none, other non-objects
 * throw; bubbles, cancelable and composed are read in order. */
static ScrEvent *scr_event_construct(ScrDyn *args, bool custom) {
  scr_et_install();
  size_t argc = args->kind == SCR_DYN_ARR ? args->v.arr.len : 0;
  if (argc == 0) {
    scr_et_type_error("The \"type\" argument must be specified", "ERR_MISSING_ARGS");
    return NULL;
  }
  ScrDyn *const *items = args->v.arr.items;
  ScrDyn *options = argc > 1 ? items[1] : NULL;
  bool has_options = options && options->kind != SCR_DYN_UNDEF && options->kind != SCR_DYN_NULL;
  if (has_options && (!scr_dyn_is_object(options) || options->kind == SCR_DYN_ARR)) {
    scr_dyn_arg_type_fail("options", "of type object", options);
    return NULL;
  }
  bool flags[3] = {false, false, false};
  static const char *const keys[] = {"bubbles", "cancelable", "composed"};
  for (size_t i = 0; has_options && i < 3; i++) {
    ScrDyn *v = scr_et_prop(options, keys[i]);
    if (!v && scr_exc_pending()) return NULL;
    flags[i] = v && scr_dyn_truthy(v);
    scr_dyn_release(v);
  }
  ScrStr *type = scr_dyn_string_coerce_js(items[0]);
  if (!type) return NULL;
  ScrEvent *ev = scr_event_alloc(type, custom);
  ev->bubbles = flags[0];
  ev->cancelable = flags[1];
  ev->composed = flags[2];
  return ev;
}

ScrDyn *scr_event_new(ScrDyn *args) {
  ScrEvent *ev = scr_event_construct(args, false);
  if (!ev) return NULL;
  ScrDyn *out = scr_dyn_new_handle(ev, SCR_DYNH_EVENT);
  scr_event_release_v(ev);
  return out;
}

ScrDyn *scr_custom_event_new(ScrDyn *args) {
  ScrEvent *ev = scr_event_construct(args, true);
  if (!ev) return NULL;
  /* `options?.detail ?? null`, read after the Event fields */
  ScrDyn *options = args->v.arr.len > 1 ? args->v.arr.items[1] : NULL;
  if (options && options->kind != SCR_DYN_UNDEF && options->kind != SCR_DYN_NULL) {
    ScrDyn *detail = scr_et_prop(options, "detail");
    if (!detail && scr_exc_pending()) {
      scr_event_release_v(ev);
      return NULL;
    }
    if (detail && detail->kind != SCR_DYN_UNDEF && detail->kind != SCR_DYN_NULL) {
      ev->detail = detail;
      scr_event_track(ev);
    } else {
      scr_dyn_release(detail);
    }
  }
  ScrDyn *out = scr_dyn_new_handle(ev, SCR_DYNH_CUSTOM_EVENT);
  scr_event_release_v(ev);
  return out;
}

bool scr_event_is(const ScrDyn *v, double kind) {
  if (v->kind != SCR_DYN_HANDLE) return false;
  ScrDynHandleTag tag = v->v.handle.tag;
  if (kind == 0) return tag == SCR_DYNH_EVENT || tag == SCR_DYNH_CUSTOM_EVENT;
  if (kind == 1) return tag == SCR_DYNH_CUSTOM_EVENT;
  return tag == SCR_DYNH_EVENT_TARGET ||
         (scr_et_signal_core_fn != NULL && tag == SCR_DYNH_ABORT_SIGNAL);
}

/* ── events.addAbortListener ───────────────────────────────────────── */

static void *scr_et_dyn_retain_v(void *p) { return scr_dyn_retain((ScrDyn *)p); }
static void scr_et_dyn_release_v(void *p) { scr_dyn_release((ScrDyn *)p); }

static ScrDyn *scr_et_box_get(ScrClosure *clo, size_t i) {
  return (ScrDyn *)scr_box_get_ref(clo->caps[i]);
}

static ScrBox *scr_et_dyn_box(ScrDyn *value) {
  ScrBox *box = scr_box_new_obj(&scr_et_dyn_retain_v, &scr_et_dyn_release_v, NULL);
  scr_box_set_ref(box, scr_dyn_retain(value));
  return box;
}

static void scr_et_aborted_listener_job(ScrClosure *job) {
  ScrDyn *listener = scr_et_box_get(job, 0);
  ScrDyn *r = scr_dyn_call(listener, NULL, 0, "listener");
  scr_dyn_release(r);
  scr_dyn_release(listener);
}

/* [SymbolDispose]() { removeEventListener?.(); } */
static ScrDyn *scr_et_abort_listener_dispose(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  (void)args;
  (void)argc;
  if (clo->ncaps == 2) {
    ScrDyn *signal = scr_et_box_get(clo, 0);
    ScrDyn *listener = scr_et_box_get(clo, 1);
    bool aborted;
    ScrEventTargetCore *core = scr_et_signal_core_fn ? scr_et_signal_core_fn(signal, &aborted) : NULL;
    if (core) {
      ScrStr *abort = scr_str_new("abort", 5);
      ScrDyn *type = scr_dyn_new_str(abort);
      scr_str_release(abort);
      ScrDyn *remove_args[2] = {type, listener};
      ScrDyn *r = scr_et_remove_listener(core, remove_args, 2);
      scr_dyn_release(r);
      scr_dyn_release(type);
    }
    scr_dyn_release(signal);
    scr_dyn_release(listener);
  }
  return scr_dyn_retain(scr_dyn_undefined());
}

ScrDyn *scr_events_add_abort_listener(ScrDyn *signal, ScrDyn *listener) {
  bool aborted = false;
  ScrEventTargetCore *core =
      signal && scr_et_signal_core_fn ? scr_et_signal_core_fn(signal, &aborted) : NULL;
  if (!core) {
    scr_dyn_arg_type_fail("signal", "an instance of AbortSignal", signal ? signal : scr_dyn_undefined());
    return NULL;
  }
  if (!listener || !scr_dyn_is_callable(listener)) {
    scr_dyn_arg_type_fail("listener", "of type function", listener ? listener : scr_dyn_undefined());
    return NULL;
  }
  ScrClosure *dispose;
  if (aborted) {
    ScrClosure *job = scr_closure_new((void *)&scr_et_aborted_listener_job, 1);
    job->caps[0] = scr_et_dyn_box(listener);
    scr_queue_microtask(job);
    dispose = scr_closure_new((void *)&scr_et_abort_listener_dispose, 0);
  } else {
    ScrStr *abort = scr_str_new("abort", 5);
    bool duplicate;
    ScrEtListener *l =
        scr_et_append(core, abort, listener, SCR_ET_ONCE | SCR_ET_RESIST, &duplicate);
    scr_str_release(abort);
    (void)l;
    dispose = scr_closure_new((void *)&scr_et_abort_listener_dispose, 2);
    dispose->caps[0] = scr_et_dyn_box(signal);
    dispose->caps[1] = scr_et_dyn_box(listener);
  }
  return scr_dyn_new_func(dispose, scr_et_abort_listener_dispose, 0, "()", "[Symbol.dispose]");
}

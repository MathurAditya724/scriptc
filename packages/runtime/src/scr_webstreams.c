/* WHATWG streams for checked-dynamic code: ReadableStream with its default
 * reader and controller, and the queuing strategies, as untyped JavaScript
 * reads them (globals and node:stream/web). The algorithms follow Node 24's
 * lib/internal/webstreams step by step, including where Node departs from
 * the specification's promise usage (its read fast path, the lazily
 * materialized closed promises), so promise jobs run in Node's order.
 *
 * Every interface is a dyn handle class (scr_dyn_handle_class.c): its
 * constructor value, prototype members and brand checks come from the
 * handle tables at the end of this file. Algorithm state is refcounted C
 * structs the cycle collector traces (WsObj); user callbacks and values are
 * dyn values.
 *
 * Promise steps: "upon settlement" is scr_promise_react, which runs as a
 * reaction job in subscription order, as PromisePrototypeThen does. */
#include "scr_runtime.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct WsReadable WsReadable;
typedef struct WsReader WsReader;
typedef struct WsRController WsRController;
typedef struct WsReadRequest WsReadRequest;
typedef struct WsTee WsTee;

static void ws_oom(void) { scr_trap("scriptc: out of memory\n"); }

static void *ws_alloc(size_t size) {
  void *p = calloc(1, size);
  if (!p) ws_oom();
  return p;
}

/* ── collected state ───────────────────────────────────────────────── */

/* Every algorithm state starts with WsObj and carries a cycle header: a
 * stream, its controller and its reader point at one another, as Node's
 * objects do, and user callbacks close over their handles, so the cycle
 * collector reclaims them. A type's trace visits every reference the state
 * holds to another state, a promise or a dyn value (every heap dyn value
 * carries a header); drop releases those references, or in a collection
 * (gc) none of them, since the collector settles what trace visits, and
 * frees the state's own buffers. */
typedef struct WsObjType {
  void (*trace)(void *obj, ScrTraceVisit visit, void *ctx);
  void (*drop)(void *obj, bool gc);
} WsObjType;

typedef struct WsObj {
  size_t rc;
  const WsObjType *type;
} WsObj;

static void ws_obj_trace(void *obj, ScrTraceVisit visit, void *ctx) {
  ((WsObj *)obj)->type->trace(obj, visit, ctx);
}

static void ws_obj_gcfree(void *obj) {
  ((WsObj *)obj)->type->drop(obj, true);
  scr_obj_free_note();
  scr_cyc_free(obj);
}

static void ws_obj_destroy(void *obj) {
  ((WsObj *)obj)->type->drop(obj, false);
  scr_obj_free_note();
  scr_cyc_free(obj);
}

static ScrCycType ws_cyc_type = {ws_obj_trace, ws_obj_gcfree, SCR_CYC_KIND_NONE, 0};

static void *ws_obj_new(size_t size, const WsObjType *type) {
  WsObj *o = scr_cyc_alloc(size, &ws_cyc_type);
  o->rc = 1;
  o->type = type;
  scr_obj_alloc_note();
  return o;
}

static void *ws_retain(void *obj) {
  ((WsObj *)obj)->rc++;
  return obj;
}

static void ws_release(void *obj) {
  WsObj *o = obj;
  if (!o) return;
  if (--o->rc == 0) {
    scr_cyc_dead(o);
    scr_rc_destroy(o, ws_obj_destroy);
  } else {
    scr_cyc_released(o);
  }
}

static void ws_visit(const void *child, ScrTraceVisit visit, void *ctx) {
  if (child) visit((void *)child, ctx);
}

static void ws_drop_dyn(ScrDyn *d, bool gc) {
  if (d && !gc) scr_dyn_release(d);
}

static void ws_drop_promise(ScrPromise *p, bool gc) {
  if (p && !gc) scr_promise_release(p);
}

static void ws_drop_obj(void *o, bool gc) {
  if (o && !gc) ws_release(o);
}

/* ── values and errors ─────────────────────────────────────────────── */

static ScrDyn *ws_undef(void) { return scr_dyn_retain(scr_dyn_undefined()); }

static bool ws_is_object(const ScrDyn *v) {
  return v && v->kind != SCR_DYN_NULL && (v->kind == SCR_DYN_FUNC || scr_dyn_is_object(v));
}

/* The pending exception as a dyn value (+1); the cell is cleared. */
static ScrDyn *ws_take_pending(void) {
  ScrCaught *c = scr_exc_take();
  ScrDyn *d = scr_caught_to_dyn(c);
  scr_caught_release(c);
  return d;
}

/* ERR_INVALID_STATE as Node's ERR_INVALID_STATE.TypeError: pending. */
static void ws_state_error(const char *message) {
  char buf[256];
  int n = snprintf(buf, sizeof buf, "Invalid state: %s", message);
  scr_throw_error_msg_code(SCR_ERR_TYPE, buf, (size_t)n, "ERR_INVALID_STATE");
}

static ScrDyn *ws_state_error_value(const char *message) {
  ws_state_error(message);
  return ws_take_pending();
}

/* ERR_INVALID_ARG_VALUE.RangeError: "The property 'name' is invalid.
 * Received <value>". */
static void ws_range_arg_value(const char *name, const ScrDyn *got) {
  char inspected[64];
  const char *text = scr_dyn_inspect_lite(got, inspected, sizeof inspected);
  char buf[256];
  int n = snprintf(buf, sizeof buf, "The %s '%s' is invalid. Received %s",
                   strchr(name, '.') ? "property" : "argument", name, text);
  scr_throw_error_msg_code(SCR_ERR_RANGE, buf, (size_t)n, "ERR_INVALID_ARG_VALUE");
}

/* validateObject with Node's kValidateObjectAllowObjects (null refused) or
 * kValidateObjectAllowObjectsAndNull. */
static bool ws_validate_object(const ScrDyn *value, const char *name, bool allow_null) {
  if (value->kind == SCR_DYN_NULL ? allow_null : ws_is_object(value)) return true;
  scr_dyn_arg_type_fail(name, "of type object", value);
  return false;
}

/* value[name] through Get (getters run); +1, or NULL with the exception
 * pending. undefined and null answer undefined, as optional chaining does. */
static ScrDyn *ws_get(const ScrDyn *object, const char *name) {
  if (object->kind == SCR_DYN_UNDEF || object->kind == SCR_DYN_NULL) return ws_undef();
  if (object->kind == SCR_DYN_HANDLE || object->kind == SCR_DYN_BYTES) {
    ScrStr *key = scr_str_new(name, strlen(name));
    ScrDyn *value = object->kind == SCR_DYN_HANDLE ? scr_dyn_handle_key_get(object, key)
                                                   : scr_dyn_bytes_key_get(object, key);
    scr_str_release(key);
    return value;
  }
  ScrStr *key = scr_str_new(name, strlen(name));
  ScrDyn *k = scr_dyn_new_str(key);
  scr_str_release(key);
  ScrDyn *value = scr_dyn_reflect_get((ScrDyn *)object, k, (ScrDyn *)object);
  scr_dyn_release(k);
  if (!value && !scr_exc_pending()) value = ws_undef();
  return value;
}

/* fn.call(self, ...args): +1, or NULL with the exception pending. */
static ScrDyn *ws_call(const ScrDyn *fn, const ScrDyn *self, ScrDyn *const *args, size_t argc, const char *what) {
  scr_dyn_this_push_dyn((ScrDyn *)self);
  ScrDyn *result = scr_dyn_call(fn, args, argc, what);
  scr_dyn_this_pop();
  return result;
}

/* validateFunction(value, name): ERR_INVALID_ARG_TYPE for any value that
 * is not callable. */
static bool ws_validate_function(const ScrDyn *value, const char *name) {
  if (scr_dyn_is_callable(value)) return true;
  scr_dyn_arg_type_fail(name, "of type function", value);
  return false;
}

/* ── promises ──────────────────────────────────────────────────────── */

static SCR_TL ScrPromise *ws_resolved_promise; /* kResolvedPromise */

static ScrPromise *ws_resolved_singleton(void) {
  if (!ws_resolved_promise) {
    ws_resolved_promise = scr_promise_new();
    scr_promise_fulfill_ref(ws_resolved_promise, ws_undef(), scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
  }
  return ws_resolved_promise;
}

static void ws_fulfill(ScrPromise *p, ScrDyn *value) {
  scr_promise_fulfill_ref(p, scr_dyn_retain(value), scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
}

static void ws_reject(ScrPromise *p, ScrDyn *reason) {
  scr_dyn_throw(scr_dyn_retain(reason));
  scr_promise_reject_pending(p);
}

/* PromiseResolve() and PromiseReject(e): fresh settled promises (+1). */
static ScrPromise *ws_promise_resolved(ScrDyn *value) {
  ScrPromise *p = scr_promise_new();
  ws_fulfill(p, value);
  return p;
}

static ScrPromise *ws_promise_rejected(ScrDyn *reason) {
  ScrPromise *p = scr_promise_new();
  ws_reject(p, reason);
  return p;
}

/* A rejected promise for the pending exception (+1). */
static ScrPromise *ws_promise_rejected_pending(void) {
  ScrPromise *p = scr_promise_new();
  scr_promise_reject_pending(p);
  return p;
}

/* setPromiseHandled. */
static void ws_set_handled(ScrPromise *p) { scr_promise_mark_handled(p); }

/* The settled value or reason of p as a dyn value (+1). */
static ScrDyn *ws_settled_value(ScrPromise *p) { return scr_promise_reason_dyn(p); }

/* The promise a `new Promise((r) => r(value))` makes, or an async
 * function's result promise when it returns value: a promise adopts through
 * its then job, a thenable through its resolve job, and any other value
 * fulfills. +1. */
static ScrPromise *ws_promise_resolving(ScrDyn *value) {
  if (value->kind == SCR_DYN_PROMISE) {
    ScrPromise *p = scr_promise_new();
    scr_promise_resolve_dyn(p, scr_dyn_retain(value));
    return p;
  }
  if (ws_is_object(value)) return scr_dyn_promise_resolve(value, NULL);
  return ws_promise_resolved(value);
}

/* PromiseResolve(value): a promise is itself. +1. */
static ScrPromise *ws_promise_resolve(ScrDyn *value) {
  if (value->kind == SCR_DYN_PROMISE) return scr_promise_retain(value->v.promise);
  return scr_dyn_promise_resolve(value, NULL);
}

/* Native promise reactions over collected contexts (WsObj, or NULL). ok and err borrow the
 * context and the value; a NULL step passes the settlement on (and marks
 * nothing). */
typedef void (*WsStep)(void *ctx, ScrDyn *value);

/* A step whose result promise the then() result adopts (+1, or NULL with
 * the exception pending). */
typedef ScrPromise *(*WsPStep)(void *ctx, ScrDyn *value);

typedef struct WsReaction {
  WsStep ok;
  WsStep err;
  WsPStep pok;
  WsPStep perr;
  void *ctx;           /* a WsObj (+1), or NULL */
  ScrPromise *derived; /* the then() result, settled by the steps' outcome */
} WsReaction;

static void ws_reaction_run(void *opaque, ScrPromise *settled) {
  WsReaction *r = opaque;
  bool rejected = scr_promise_is_rejected(settled);
  WsStep step = rejected ? r->err : r->ok;
  WsPStep pstep = rejected ? r->perr : r->pok;
  ScrDyn *value = ws_settled_value(settled);
  if (pstep) {
    ScrPromise *adopted = pstep(r->ctx, value);
    if (!adopted) {
      scr_promise_reject_pending(r->derived);
    } else {
      ScrDyn *box = scr_dyn_new_promise(adopted);
      scr_promise_release(adopted);
      scr_promise_resolve_dyn(r->derived, box);
    }
    scr_dyn_release(value);
    return;
  }
  if (step) step(r->ctx, value);
  if (r->derived) {
    if (scr_exc_pending()) scr_promise_reject_pending(r->derived);
    else if (rejected && !step) ws_reject(r->derived, value);
    else {
      ScrDyn *u = ws_undef();
      ws_fulfill(r->derived, u);
      scr_dyn_release(u);
    }
  } else if (scr_exc_pending()) {
    /* A step's own throw in a reaction nobody observes: Node's then
     * result rejects unhandled, which reports. */
    ScrPromise *lost = ws_promise_rejected_pending();
    scr_promise_release(lost);
  }
  scr_dyn_release(value);
}

static void ws_reaction_drop(void *opaque) {
  WsReaction *r = opaque;
  ws_release(r->ctx);
  if (r->derived) scr_promise_release(r->derived);
  free(r);
}

static const ScrPromiseReaction ws_reaction = {ws_reaction_run, ws_reaction_drop};

/* PromisePrototypeThen(p, ok, err) with native steps; the caller's +1 on
 * ctx moves in. Answers the derived promise (+1) when want_derived. */
static ScrPromise *ws_then(ScrPromise *p, WsStep ok, WsStep err, void *ctx, bool want_derived) {
  WsReaction *r = ws_alloc(sizeof *r);
  r->ok = ok;
  r->err = err;
  r->ctx = ctx;
  ScrPromise *derived = NULL;
  if (want_derived) {
    derived = scr_promise_new();
    r->derived = scr_promise_retain(derived);
  }
  scr_promise_react(p, &ws_reaction, r);
  return derived;
}

/* PromisePrototypeThen(p, pok, perr) where the handlers return promises
 * the result adopts: the derived promise (+1). */
static ScrPromise *ws_then_adopt(ScrPromise *p, WsPStep pok, WsPStep perr, void *ctx) {
  WsReaction *r = ws_alloc(sizeof *r);
  r->pok = pok;
  r->perr = perr;
  r->ctx = ctx;
  ScrPromise *derived = scr_promise_new();
  r->derived = scr_promise_retain(derived);
  scr_promise_react(p, &ws_reaction, r);
  return derived;
}

/* `then(p, () => {})`: a promise fulfilled with undefined after p fulfills,
 * rejected with p's reason (+1). */
static ScrPromise *ws_then_void(ScrPromise *p) { return ws_then(p, NULL, NULL, NULL, true); }

/* thenAlgorithmResult (util.js): a non-object result continues from the
 * shared resolved promise; any other result through PromiseResolve. ctx
 * is borrowed. */
static void ws_then_algorithm_result(ScrDyn *result, WsStep ok, WsStep err, void *ctx) {
  if (!ws_is_object(result)) {
    ws_then(ws_resolved_singleton(), ok, NULL, ws_retain(ctx), false);
    return;
  }
  ScrPromise *p = ws_promise_resolve(result);
  if (!p) {
    /* PromiseResolve's then read threw: the algorithm result rejects. */
    p = ws_promise_rejected_pending();
  }
  ws_then(p, ok, err, ws_retain(ctx), false);
  scr_promise_release(p);
}

/* queueMicrotask(fn) with a native step; the caller's +1 on ctx moves in. */
static void ws_queue_microtask(WsStep step, void *ctx) {
  ws_then(ws_resolved_singleton(), step, NULL, ctx, false);
}

/* process.nextTick(fn) with a native step; the caller's +1 on ctx moves
 * in. The tick queue holds it until the step runs. */
typedef struct WsTick {
  WsStep step;
  void *ctx;
} WsTick;

static void *ws_tick_retain(void *p) { return p; }
static void ws_tick_release(void *p) {
  WsTick *t = p;
  ws_release(t->ctx);
  free(t);
}

static void ws_tick_run(ScrClosure *self) {
  WsTick *t = scr_box_get_ref(self->caps[0]);
  t->step(t->ctx, NULL);
}

static void ws_next_tick(WsStep step, void *ctx) {
  WsTick *t = ws_alloc(sizeof *t);
  t->step = step;
  t->ctx = ctx;
  ScrClosure *cb = scr_closure_new((void *)ws_tick_run, 1);
  cb->caps[0] = scr_box_new_obj(ws_tick_retain, ws_tick_release, NULL);
  scr_box_set_ref(cb->caps[0], t);
  scr_next_tick(cb);
}

/* A promise with its resolvers, settled at most once. */
typedef struct WsDeferred {
  ScrPromise *promise;
  bool settled;
} WsDeferred;

static void ws_deferred_init(WsDeferred *d) {
  d->promise = scr_promise_new();
  d->settled = false;
}

static void ws_deferred_resolve(WsDeferred *d, ScrDyn *value) {
  if (d->settled) return;
  d->settled = true;
  ws_fulfill(d->promise, value);
}

static void ws_deferred_resolve_undefined(WsDeferred *d) {
  ScrDyn *u = ws_undef();
  ws_deferred_resolve(d, u);
  scr_dyn_release(u);
}

/* resolve(promiseValue): adopts a promise the way a resolver called with
 * one does. */
static void ws_deferred_resolve_promise(WsDeferred *d, ScrPromise *value) {
  if (d->settled) return;
  d->settled = true;
  ScrDyn *box = scr_dyn_new_promise(value);
  scr_promise_resolve_dyn(d->promise, box);
}

static void ws_deferred_reject(WsDeferred *d, ScrDyn *reason) {
  if (d->settled) return;
  d->settled = true;
  ws_reject(d->promise, reason);
}

/* ── the queue (Queue's pairs, util.js) ───────────────────────────── */

typedef struct WsQueue {
  ScrDyn **values;
  double *sizes;
  size_t head, length, capacity;
} WsQueue;

static void ws_queue_push(WsQueue *q, ScrDyn *value, double size) {
  if (q->length == q->capacity) {
    size_t capacity = q->capacity ? q->capacity * 2 : 8;
    ScrDyn **values = malloc(capacity * sizeof *values);
    double *sizes = malloc(capacity * sizeof *sizes);
    if (!values || !sizes) ws_oom();
    for (size_t i = 0; i < q->length; i++) {
      values[i] = q->values[(q->head + i) % q->capacity];
      sizes[i] = q->sizes[(q->head + i) % q->capacity];
    }
    free(q->values);
    free(q->sizes);
    q->values = values;
    q->sizes = sizes;
    q->head = 0;
    q->capacity = capacity;
  }
  size_t at = (q->head + q->length) % q->capacity;
  q->values[at] = scr_dyn_retain(value);
  q->sizes[at] = size;
  q->length++;
}

/* The front value (+1 moves out) and its size. */
static ScrDyn *ws_queue_shift(WsQueue *q, double *size) {
  ScrDyn *value = q->values[q->head];
  *size = q->sizes[q->head];
  q->head = (q->head + 1) % q->capacity;
  q->length--;
  if (q->length == 0) q->head = 0;
  return value;
}

static void ws_queue_drop(WsQueue *q, bool gc) {
  if (!gc)
    for (size_t i = 0; i < q->length; i++) scr_dyn_release(q->values[(q->head + i) % q->capacity]);
  free(q->values);
  free(q->sizes);
  memset(q, 0, sizeof *q);
}

static void ws_queue_reset(WsQueue *q) { ws_queue_drop(q, false); }

static void ws_queue_trace(const WsQueue *q, ScrTraceVisit visit, void *ctx) {
  for (size_t i = 0; i < q->length; i++) visit(q->values[(q->head + i) % q->capacity], ctx);
}

/* ── read requests ─────────────────────────────────────────────────── */

typedef struct WsReadRequestOps {
  /* Each step consumes the request. Values are borrowed. */
  void (*chunk)(WsReadRequest *r, ScrDyn *chunk);
  void (*close)(WsReadRequest *r);
  void (*error)(WsReadRequest *r, ScrDyn *error);
} WsReadRequestOps;

struct WsReadRequest {
  const WsReadRequestOps *ops;
  WsReadRequest *next;
  ScrPromise *promise; /* +1, or NULL */
  void *ctx;           /* a WsObj (+1), or NULL */
};

static ScrDyn *ws_read_result(ScrDyn *value, bool done) {
  ScrDyn *result = scr_dyn_new_obj();
  scr_dyn_obj_set(result, "value", 5, scr_dyn_retain(value));
  scr_dyn_obj_set(result, "done", 4, scr_dyn_new_bool(done));
  return result;
}

/* DefaultReadRequest. */
static void ws_default_chunk(WsReadRequest *r, ScrDyn *chunk) {
  ScrDyn *result = ws_read_result(chunk, false);
  ws_fulfill(r->promise, result);
  scr_dyn_release(result);
  scr_promise_release(r->promise);
  free(r);
}

static void ws_default_close(WsReadRequest *r) {
  ScrDyn *u = ws_undef();
  ScrDyn *result = ws_read_result(u, true);
  scr_dyn_release(u);
  ws_fulfill(r->promise, result);
  scr_dyn_release(result);
  scr_promise_release(r->promise);
  free(r);
}

static void ws_default_error(WsReadRequest *r, ScrDyn *error) {
  ws_reject(r->promise, error);
  scr_promise_release(r->promise);
  free(r);
}

static const WsReadRequestOps ws_default_request_ops = {ws_default_chunk, ws_default_close, ws_default_error};

/* ── ReadableStream state ──────────────────────────────────────────── */

typedef enum { WS_STATE_READABLE, WS_STATE_CLOSED, WS_STATE_ERRORED } WsState;

/* Native algorithms for streams the runtime makes (tee branches, from()):
 * pull answers the algorithm's result (+1 dyn, or NULL with the exception
 * pending, or the parked sentinel), cancel a promise (+1). The context is
 * a WsObj the controller holds until it clears its algorithms. */
typedef struct WsSourceOps {
  ScrDyn *(*pull)(void *ctx, WsRController *c);
  ScrPromise *(*cancel)(void *ctx, WsRController *c, ScrDyn *reason);
} WsSourceOps;

struct WsReadable {
  WsObj obj;
  WsState state;
  bool disturbed;
  ScrDyn *stored_error;
  WsReader *reader;          /* +1 while locked */
  WsRController *controller; /* +1 */
  WsDeferred closed;         /* kIsClosedPromise, materialized on use */
  bool closed_materialized;
};

struct WsRController {
  WsObj obj;
  WsReadable *stream; /* +1 */
  WsQueue queue;
  double queue_total_size;
  double high_water_mark;
  bool started, close_requested, pull_again, pulling, algorithms_cleared;
  /* The underlying source's algorithms (user source), or native ones. */
  ScrDyn *source;
  ScrDyn *pull_fn;
  ScrDyn *cancel_fn;
  ScrDyn *size_fn; /* NULL = the default size algorithm */
  const WsSourceOps *native;
  void *native_ctx; /* +1 */
  int native_branch; /* a tee branch's number */
};

struct WsReader {
  WsObj obj;
  WsReadable *stream; /* +1 while attached */
  WsReadRequest *head, *tail;
  size_t requests;
  /* The closed promise record, materialized on first observation: the
   * promise, and whether its resolvers are still live (PromiseWithResolvers)
   * or it was made settled. */
  ScrPromise *closed;
  bool closed_live;
  /* The tee reading through this reader (+1), which reacts to the
   * stream's error as Node's reaction to the closed promise does. */
  WsTee *tee;
};

static SCR_TL ScrDyn *ws_released_error;  /* "Reader released" */
static SCR_TL ScrDyn *ws_releasing_error; /* "Releasing reader" */
static SCR_TL bool ws_teardown_registered;

static void ws_teardown(void) {
  if (ws_released_error) scr_dyn_release(ws_released_error);
  if (ws_releasing_error) scr_dyn_release(ws_releasing_error);
  if (ws_resolved_promise) scr_promise_release(ws_resolved_promise);
  ws_released_error = ws_releasing_error = NULL;
  ws_resolved_promise = NULL;
}

static void ws_register_teardown(void) {
  if (ws_teardown_registered) return;
  ws_teardown_registered = true;
  scr_atexit(ws_teardown);
}

static ScrDyn *ws_reader_released_error(void) {
  if (!ws_released_error) {
    ws_register_teardown();
    ws_released_error = ws_state_error_value("Reader released");
  }
  return ws_released_error;
}

static ScrDyn *ws_reader_releasing_error(void) {
  if (!ws_releasing_error) {
    ws_register_teardown();
    ws_releasing_error = ws_state_error_value("Releasing reader");
  }
  return ws_releasing_error;
}

static WsReadable *ws_readable_retain(WsReadable *s) { return ws_retain(s); }
static WsRController *ws_rcontroller_retain(WsRController *c) { return ws_retain(c); }
static WsReader *ws_reader_retain(WsReader *r) { return ws_retain(r); }
static void ws_readable_release(WsReadable *s) { ws_release(s); }
static void ws_reader_release(WsReader *r) { ws_release(r); }

static void ws_readable_trace(void *obj, ScrTraceVisit visit, void *ctx) {
  WsReadable *s = obj;
  ws_visit(s->stored_error, visit, ctx);
  ws_visit(s->reader, visit, ctx);
  ws_visit(s->controller, visit, ctx);
  if (s->closed_materialized) ws_visit(s->closed.promise, visit, ctx);
}

static void ws_readable_drop(void *obj, bool gc) {
  WsReadable *s = obj;
  ws_drop_dyn(s->stored_error, gc);
  ws_drop_obj(s->reader, gc);
  ws_drop_obj(s->controller, gc);
  if (s->closed_materialized) ws_drop_promise(s->closed.promise, gc);
}

static const WsObjType ws_readable_type = {ws_readable_trace, ws_readable_drop};

static void ws_rcontroller_trace(void *obj, ScrTraceVisit visit, void *ctx) {
  WsRController *c = obj;
  ws_visit(c->stream, visit, ctx);
  ws_queue_trace(&c->queue, visit, ctx);
  ws_visit(c->source, visit, ctx);
  ws_visit(c->pull_fn, visit, ctx);
  ws_visit(c->cancel_fn, visit, ctx);
  ws_visit(c->size_fn, visit, ctx);
  ws_visit(c->native_ctx, visit, ctx);
}

static void ws_rcontroller_drop(void *obj, bool gc) {
  WsRController *c = obj;
  ws_queue_drop(&c->queue, gc);
  ws_drop_dyn(c->source, gc);
  ws_drop_dyn(c->pull_fn, gc);
  ws_drop_dyn(c->cancel_fn, gc);
  ws_drop_dyn(c->size_fn, gc);
  ws_drop_obj(c->native_ctx, gc);
  ws_drop_obj(c->stream, gc);
}

static const WsObjType ws_rcontroller_type = {ws_rcontroller_trace, ws_rcontroller_drop};

static void ws_reader_trace(void *obj, ScrTraceVisit visit, void *ctx) {
  WsReader *r = obj;
  ws_visit(r->stream, visit, ctx);
  ws_visit(r->closed, visit, ctx);
  ws_visit(r->tee, visit, ctx);
  for (WsReadRequest *q = r->head; q; q = q->next) {
    ws_visit(q->promise, visit, ctx);
    ws_visit(q->ctx, visit, ctx);
  }
}

static void ws_reader_drop(void *obj, bool gc) {
  WsReader *r = obj;
  while (r->head) {
    WsReadRequest *q = r->head;
    r->head = q->next;
    ws_drop_promise(q->promise, gc);
    ws_drop_obj(q->ctx, gc);
    free(q);
  }
  ws_drop_promise(r->closed, gc);
  ws_drop_obj(r->tee, gc);
  ws_drop_obj(r->stream, gc);
}

static const WsObjType ws_reader_type = {ws_reader_trace, ws_reader_drop};

/* ── handles ───────────────────────────────────────────────────────── */

/* A handle over a state (+1); the collector traces the handle's edge to
 * it. */
static ScrDyn *ws_box(void *state, ScrDynHandleTag tag) {
  ScrDyn *d = scr_dyn_new_handle(state, tag);
  d->v.handle.traced = true;
  return d;
}

static ScrDyn *ws_stream_box(WsReadable *s) { return ws_box(s, SCR_DYNH_WS_READABLE); }
static ScrDyn *ws_reader_box(WsReader *r) { return ws_box(r, SCR_DYNH_WS_READER); }
static ScrDyn *ws_rcontroller_box(WsRController *c) { return ws_box(c, SCR_DYNH_WS_RCONTROLLER); }

static WsReadable *ws_stream_of(const ScrDyn *d) {
  return d && d->kind == SCR_DYN_HANDLE && d->v.handle.tag == SCR_DYNH_WS_READABLE ? d->v.handle.ptr : NULL;
}

static void ws_install(void);

/* ── ReadableStream abstract operations ───────────────────────────── */

static bool ws_readable_locked(WsReadable *s) { return s->reader != NULL; }

static void ws_rcontroller_clear_algorithms(WsRController *c) {
  if (c->algorithms_cleared) return;
  c->algorithms_cleared = true;
  ScrDyn *source = c->source, *pull = c->pull_fn, *cancel = c->cancel_fn, *size = c->size_fn;
  void *native_ctx = c->native_ctx;
  c->source = c->pull_fn = c->cancel_fn = c->size_fn = NULL;
  c->native_ctx = NULL;
  if (source) scr_dyn_release(source);
  if (pull) scr_dyn_release(pull);
  if (cancel) scr_dyn_release(cancel);
  if (size) scr_dyn_release(size);
  ws_release(native_ctx);
}

static void ws_readable_close(WsReadable *s) {
  s->state = WS_STATE_CLOSED;
  if (s->closed_materialized) ws_deferred_resolve_undefined(&s->closed);
  WsReader *r = s->reader;
  if (!r) return;
  if (r->closed && r->closed_live) {
    r->closed_live = false;
    ScrDyn *u = ws_undef();
    ws_fulfill(r->closed, u);
    scr_dyn_release(u);
  }
  ws_reader_retain(r);
  while (r->head) {
    WsReadRequest *q = r->head;
    r->head = q->next;
    if (!r->head) r->tail = NULL;
    r->requests--;
    q->ops->close(q);
  }
  ws_reader_release(r);
}

static void ws_tee_source_error(WsTee *t, ScrDyn *error);

static void ws_readable_error(WsReadable *s, ScrDyn *error) {
  s->state = WS_STATE_ERRORED;
  s->stored_error = scr_dyn_retain(error);
  if (s->closed_materialized) {
    ws_set_handled(s->closed.promise);
    ws_deferred_reject(&s->closed, error);
  }
  WsReader *r = s->reader;
  if (!r) return;
  if (r->closed && r->closed_live) {
    r->closed_live = false;
    ws_set_handled(r->closed);
    ws_reject(r->closed, error);
  }
  if (r->tee) ws_tee_source_error(r->tee, error);
  ws_reader_retain(r);
  while (r->head) {
    WsReadRequest *q = r->head;
    r->head = q->next;
    if (!r->head) r->tail = NULL;
    r->requests--;
    q->ops->error(q, error);
  }
  ws_reader_release(r);
}

static void ws_readable_add_read_request(WsReadable *s, WsReadRequest *q) {
  WsReader *r = s->reader;
  q->next = NULL;
  if (r->tail) r->tail->next = q;
  else r->head = q;
  r->tail = q;
  r->requests++;
}

static void ws_readable_fulfill_read_request(WsReadable *s, ScrDyn *chunk) {
  WsReader *r = s->reader;
  WsReadRequest *q = r->head;
  r->head = q->next;
  if (!r->head) r->tail = NULL;
  r->requests--;
  q->ops->chunk(q, chunk);
}

static ScrPromise *ws_rcontroller_cancel_steps(WsRController *c, ScrDyn *reason);

/* readableStreamCancel: +1 promise. */
static ScrPromise *ws_readable_cancel(WsReadable *s, ScrDyn *reason) {
  s->disturbed = true;
  if (s->state == WS_STATE_CLOSED) {
    ScrDyn *u = ws_undef();
    ScrPromise *p = ws_promise_resolved(u);
    scr_dyn_release(u);
    return p;
  }
  if (s->state == WS_STATE_ERRORED) return ws_promise_rejected(s->stored_error);
  ws_readable_close(s);
  ScrPromise *source = ws_rcontroller_cancel_steps(s->controller, reason);
  ScrPromise *result = ws_then_void(source);
  scr_promise_release(source);
  return result;
}

/* readerClosedPromise: the reader's closed promise, materialized. Borrowed. */
static ScrPromise *ws_reader_closed_promise(WsReader *r) {
  if (r->closed) return r->closed;
  WsReadable *s = r->stream;
  if (!s) {
    r->closed = ws_promise_rejected(ws_reader_released_error());
    ws_set_handled(r->closed);
    r->closed_live = false;
  } else if (s->state == WS_STATE_READABLE) {
    r->closed = scr_promise_new();
    r->closed_live = true;
  } else if (s->state == WS_STATE_CLOSED) {
    ScrDyn *u = ws_undef();
    r->closed = ws_promise_resolved(u);
    scr_dyn_release(u);
    r->closed_live = false;
  } else {
    r->closed = ws_promise_rejected(s->stored_error);
    ws_set_handled(r->closed);
    r->closed_live = false;
  }
  return r->closed;
}

/* readableStreamReaderGenericRelease. */
static void ws_reader_generic_release(WsReader *r) {
  WsReadable *s = r->stream;
  if (s->state == WS_STATE_READABLE) {
    if (r->closed) {
      if (r->closed_live) {
        r->closed_live = false;
        ws_reject(r->closed, ws_reader_released_error());
      }
      ws_set_handled(r->closed);
    }
  } else if (r->closed) {
    scr_promise_release(r->closed);
    r->closed = NULL;
  }
  s->reader = NULL;
  r->stream = NULL;
  ws_reader_release(r); /* the stream's reference */
  ws_readable_release(s);
}

/* readableStreamDefaultReaderRelease. */
static void ws_reader_release_lock(WsReader *r) {
  ws_reader_retain(r);
  ws_reader_generic_release(r);
  while (r->head) {
    WsReadRequest *q = r->head;
    r->head = q->next;
    if (!r->head) r->tail = NULL;
    r->requests--;
    q->ops->error(q, ws_reader_releasing_error());
  }
  ws_reader_release(r);
}

/* setupReadableStreamDefaultReader: false with the exception pending. */
/* setupReadableStreamDefaultReader: the new reader (+1), or NULL with the
 * exception pending. */
static WsReader *ws_reader_new(WsReadable *s) {
  if (ws_readable_locked(s)) {
    ws_state_error("ReadableStream is locked");
    return NULL;
  }
  WsReader *r = ws_obj_new(sizeof *r, &ws_reader_type);
  r->stream = ws_readable_retain(s);
  s->reader = ws_reader_retain(r);
  return r;
}

/* ── the default controller ────────────────────────────────────────── */

static bool ws_rcontroller_can_close_or_enqueue(WsRController *c) {
  return !c->close_requested && c->stream->state == WS_STATE_READABLE;
}

static void ws_rcontroller_pull(WsRController *c);

static bool ws_rcontroller_should_call_pull(WsRController *c) {
  WsReadable *s = c->stream;
  if (c->close_requested || s->state != WS_STATE_READABLE || !c->started) return false;
  if (s->reader && s->reader->requests) return true;
  return c->high_water_mark - c->queue_total_size > 0;
}

static void ws_rcontroller_call_pull_if_needed(WsRController *c) {
  if (ws_rcontroller_should_call_pull(c)) ws_rcontroller_pull(c);
}

static void ws_rcontroller_error(WsRController *c, ScrDyn *error) {
  WsReadable *s = c->stream;
  if (s->state != WS_STATE_READABLE) return;
  ws_queue_reset(&c->queue);
  c->queue_total_size = 0;
  ws_rcontroller_clear_algorithms(c);
  ws_readable_error(s, error);
}

static void ws_rcontroller_close(WsRController *c) {
  if (!ws_rcontroller_can_close_or_enqueue(c)) return;
  c->close_requested = true;
  if (!c->queue.length) {
    ws_rcontroller_clear_algorithms(c);
    ws_readable_close(c->stream);
  }
}

/* readableStreamDefaultControllerEnqueue: false with the exception pending
 * (the size algorithm threw, or its size was invalid; the stream errors). */
static bool ws_rcontroller_enqueue(WsRController *c, ScrDyn *chunk) {
  WsReadable *s = c->stream;
  if (c->close_requested || s->state != WS_STATE_READABLE) return true;
  if (s->reader && s->reader->requests) {
    ws_readable_fulfill_read_request(s, chunk);
  } else if (!c->size_fn) {
    ws_queue_push(&c->queue, chunk, 1);
    c->queue_total_size++;
    if (c->started && c->high_water_mark - c->queue_total_size > 0) ws_rcontroller_pull(c);
    return true;
  } else {
    ScrDyn *size_fn = scr_dyn_retain(c->size_fn);
    ScrDyn *size = ws_call(size_fn, scr_dyn_undefined(), &chunk, 1, "strategy.size");
    scr_dyn_release(size_fn);
    double coerced = NAN;
    if (size) {
      coerced = scr_dyn_number_coerce(size);
      if (!scr_exc_pending() && (isnan(coerced) || coerced < 0 || isinf(coerced)))
        ws_range_arg_value("size", size);
      scr_dyn_release(size);
    }
    if (scr_exc_pending()) {
      ScrDyn *error = ws_take_pending();
      ws_rcontroller_error(c, error);
      scr_dyn_throw(error);
      return false;
    }
    ws_queue_push(&c->queue, chunk, coerced);
    c->queue_total_size += coerced;
  }
  ws_rcontroller_call_pull_if_needed(c);
  return true;
}

static ScrDyn *ws_rcontroller_desired_size(WsRController *c) {
  switch (c->stream->state) {
  case WS_STATE_ERRORED: return scr_dyn_new_null();
  case WS_STATE_CLOSED: return scr_dyn_new_num(0);
  default: return scr_dyn_new_num(c->high_water_mark - c->queue_total_size);
  }
}

static void ws_pull_fulfilled(void *ctx, ScrDyn *value) {
  (void)value;
  WsRController *c = ctx;
  c->pulling = false;
  if (c->pull_again) {
    c->pull_again = false;
    ws_rcontroller_call_pull_if_needed(c);
  }
}

static void ws_pull_rejected(void *ctx, ScrDyn *error) {
  ws_rcontroller_error(ctx, error);
}

/* The parked algorithm result (kParkedAlgorithmResult): the algorithm
 * settles the pull itself. */
static ScrDyn ws_parked_value;
#define WS_PARKED (&ws_parked_value)

static void ws_rcontroller_pull(WsRController *c) {
  if (c->pulling) {
    c->pull_again = true;
    return;
  }
  c->pulling = true;
  ScrDyn *result;
  if (c->native) {
    result = c->native->pull(c->native_ctx, c);
  } else if (c->pull_fn) {
    ScrDyn *controller = ws_rcontroller_box(c);
    ScrDyn *pull = scr_dyn_retain(c->pull_fn);
    ScrDyn *source = scr_dyn_retain(c->source);
    result = ws_call(pull, source, &controller, 1, "source.pull");
    scr_dyn_release(pull);
    scr_dyn_release(source);
    scr_dyn_release(controller);
  } else {
    result = ws_undef(); /* nonOpCallback */
  }
  if (result == WS_PARKED) return;
  if (!result) {
    ScrPromise *rejected = ws_promise_rejected_pending();
    ws_then(rejected, ws_pull_fulfilled, ws_pull_rejected, ws_rcontroller_retain(c), false);
    scr_promise_release(rejected);
    return;
  }
  ws_then_algorithm_result(result, ws_pull_fulfilled, ws_pull_rejected, c);
  scr_dyn_release(result);
}

/* readableStreamDefaultControllerCancelSteps: the cancel algorithm's
 * promise (+1). */
static ScrPromise *ws_rcontroller_cancel_steps(WsRController *c, ScrDyn *reason) {
  ws_queue_reset(&c->queue);
  c->queue_total_size = 0;
  ScrPromise *result;
  if (c->native) {
    result = c->native->cancel(c->native_ctx, c, reason);
  } else if (c->cancel_fn) {
    /* createPromiseCallback1Param: an async arrow around the call. */
    ScrDyn *cancel = scr_dyn_retain(c->cancel_fn);
    ScrDyn *source = scr_dyn_retain(c->source);
    ScrDyn *r = ws_call(cancel, source, &reason, 1, "source.cancel");
    scr_dyn_release(cancel);
    scr_dyn_release(source);
    if (!r) {
      result = ws_promise_rejected_pending();
    } else {
      result = ws_promise_resolving(r);
      scr_dyn_release(r);
    }
  } else {
    ScrDyn *u = ws_undef(); /* nonOpCancel */
    result = ws_promise_resolved(u);
    scr_dyn_release(u);
  }
  ws_rcontroller_clear_algorithms(c);
  return result;
}

/* readableStreamDefaultControllerPullSteps. */
static void ws_rcontroller_pull_steps(WsRController *c, WsReadRequest *q) {
  WsReadable *s = c->stream;
  if (c->queue.length) {
    double size;
    ScrDyn *chunk = ws_queue_shift(&c->queue, &size);
    c->queue_total_size = fmax(0, c->queue_total_size - size);
    if (c->close_requested && !c->queue.length) {
      ws_rcontroller_clear_algorithms(c);
      ws_readable_close(s);
    } else if (!c->close_requested && c->started && c->high_water_mark - c->queue_total_size > 0) {
      ws_rcontroller_pull(c);
    }
    q->ops->chunk(q, chunk);
    scr_dyn_release(chunk);
    return;
  }
  ws_readable_add_read_request(s, q);
  if (c->started) ws_rcontroller_pull(c);
}

/* readableStreamDefaultReaderRead. */
static void ws_reader_read_request(WsReader *r, WsReadRequest *q) {
  WsReadable *s = r->stream;
  s->disturbed = true;
  switch (s->state) {
  case WS_STATE_CLOSED: q->ops->close(q); break;
  case WS_STATE_ERRORED: q->ops->error(q, s->stored_error); break;
  default: ws_rcontroller_pull_steps(s->controller, q); break;
  }
}

static void ws_start_fulfilled(void *ctx, ScrDyn *value) {
  (void)value;
  WsRController *c = ctx;
  c->started = true;
  ws_rcontroller_call_pull_if_needed(c);
}

static void ws_start_rejected(void *ctx, ScrDyn *error) {
  ws_rcontroller_error(ctx, error);
}

/* setupReadableStreamDefaultController after the algorithms are in place:
 * runs the start algorithm's result. */
static void ws_rcontroller_started_with(WsRController *c, ScrDyn *start_result) {
  if (!ws_is_object(start_result)) {
    ws_queue_microtask(ws_start_fulfilled, ws_rcontroller_retain(c));
    return;
  }
  ScrPromise *p = ws_promise_resolving(start_result);
  if (!p) p = ws_promise_rejected_pending();
  ws_then(p, ws_start_fulfilled, ws_start_rejected, ws_rcontroller_retain(c), false);
  scr_promise_release(p);
}

static WsReadable *ws_readable_alloc(void) {
  WsReadable *s = ws_obj_new(sizeof *s, &ws_readable_type);
  s->state = WS_STATE_READABLE;
  return s;
}

static WsRController *ws_rcontroller_attach(WsReadable *s, double high_water_mark) {
  WsRController *c = ws_obj_new(sizeof *c, &ws_rcontroller_type);
  c->stream = ws_readable_retain(s);
  c->high_water_mark = high_water_mark;
  s->controller = c; /* the stream's reference */
  return c;
}

/* createReadableStream with native algorithms and the nonOp start: the new
 * stream (+1). The native context's reference moves in. */
static WsReadable *ws_readable_create_native(const WsSourceOps *ops, void *ctx, int branch, double high_water_mark) {
  ws_install();
  WsReadable *s = ws_readable_alloc();
  WsRController *c = ws_rcontroller_attach(s, high_water_mark);
  c->native = ops;
  c->native_ctx = ctx;
  c->native_branch = branch;
  ScrDyn *u = ws_undef();
  ws_rcontroller_started_with(c, u);
  scr_dyn_release(u);
  return s;
}

/* extractHighWaterMark: false with the exception pending. */
static bool ws_extract_high_water_mark(ScrDyn *value, double fallback, double *out) {
  if (value->kind == SCR_DYN_UNDEF) {
    *out = fallback;
    return true;
  }
  double coerced = scr_dyn_number_coerce(value);
  if (scr_exc_pending()) return false;
  if (isnan(coerced) || coerced < 0) {
    ws_range_arg_value("strategy.highWaterMark", value);
    return false;
  }
  *out = coerced;
  return true;
}

/* new ReadableStream(source, strategy): +1 handle, or NULL with the
 * exception pending. */
static ScrDyn *ws_readable_construct(ScrDyn *const *args, size_t argc) {
  ScrDyn *source = argc > 0 && args[0]->kind != SCR_DYN_UNDEF ? args[0] : NULL;
  ScrDyn *strategy = argc > 1 && args[1]->kind != SCR_DYN_UNDEF ? args[1] : NULL;
  ScrDyn *empty = NULL;
  if (!source || !strategy) empty = scr_dyn_new_obj();
  if (!source) source = empty;
  if (!strategy) strategy = empty;
  ScrDyn *result = NULL;
  ScrDyn *size = NULL, *hwm = NULL, *type = NULL, *start = NULL, *pull = NULL, *cancel = NULL;
  if (!ws_validate_object(source, "source", false) || !ws_validate_object(strategy, "strategy", true)) goto done;
  if (!(size = ws_get(strategy, "size"))) goto done;
  if (!(hwm = ws_get(strategy, "highWaterMark"))) goto done;
  if (!(type = ws_get(source, "type"))) goto done;
  if (type->kind != SCR_DYN_UNDEF) {
    ScrStr *text = scr_dyn_string_coerce_js(type);
    if (!text) goto done;
    bool bytes = text->len == 5 && memcmp(text->data, "bytes", 5) == 0;
    scr_str_release(text);
    if (bytes) {
      static const char message[] = "ReadableStream byte streams ({ type: 'bytes' }) are not supported yet";
      scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
      goto done;
    }
    scr_dyn_arg_value_fail("source.type", NULL, type);
    goto done;
  }
  double high_water_mark;
  if (!ws_extract_high_water_mark(hwm, 1, &high_water_mark)) goto done;
  if (size->kind != SCR_DYN_UNDEF && !ws_validate_function(size, "strategy.size")) goto done;
  if (!(start = ws_get(source, "start"))) goto done;
  if (!(pull = ws_get(source, "pull"))) goto done;
  if (!(cancel = ws_get(source, "cancel"))) goto done;
  bool has_pull = scr_dyn_truthy(pull), has_cancel = scr_dyn_truthy(cancel);
  if (has_pull && !ws_validate_function(pull, "source.pull")) goto done;
  if (has_cancel && !ws_validate_function(cancel, "source.cancel")) goto done;
  ws_install();
  WsReadable *s = ws_readable_alloc();
  WsRController *c = ws_rcontroller_attach(s, high_water_mark);
  c->source = scr_dyn_retain(source);
  if (has_pull) c->pull_fn = scr_dyn_retain(pull);
  if (has_cancel) c->cancel_fn = scr_dyn_retain(cancel);
  if (size->kind != SCR_DYN_UNDEF) c->size_fn = scr_dyn_retain(size);
  ScrDyn *start_result;
  if (scr_dyn_truthy(start)) {
    ScrDyn *controller = ws_rcontroller_box(c);
    start_result = ws_call(start, source, &controller, 1, "source.start");
    scr_dyn_release(controller);
  } else {
    start_result = ws_undef();
  }
  if (!start_result) {
    ws_readable_release(s);
    goto done;
  }
  ws_rcontroller_started_with(c, start_result);
  scr_dyn_release(start_result);
  result = ws_stream_box(s);
  ws_readable_release(s);
done:
  if (empty) scr_dyn_release(empty);
  if (size) scr_dyn_release(size);
  if (hwm) scr_dyn_release(hwm);
  if (type) scr_dyn_release(type);
  if (start) scr_dyn_release(start);
  if (pull) scr_dyn_release(pull);
  if (cancel) scr_dyn_release(cancel);
  return result;
}

/* ── tee (readableStreamDefaultTee) ───────────────────────────────── */

struct WsTee {
  WsObj obj;
  WsReader *reader;
  bool reading, canceled1, canceled2;
  ScrDyn *reason1, *reason2;
  WsReadable *branch1, *branch2; /* +1 each */
  WsDeferred cancel_promise;
  ScrDyn *pending_chunk;
  ScrDyn *source_error; /* the error the source stream errored with */
  bool request_live;
};

static void ws_tee_trace(void *obj, ScrTraceVisit visit, void *ctx) {
  WsTee *t = obj;
  ws_visit(t->reader, visit, ctx);
  ws_visit(t->reason1, visit, ctx);
  ws_visit(t->reason2, visit, ctx);
  ws_visit(t->pending_chunk, visit, ctx);
  ws_visit(t->source_error, visit, ctx);
  ws_visit(t->branch1, visit, ctx);
  ws_visit(t->branch2, visit, ctx);
  ws_visit(t->cancel_promise.promise, visit, ctx);
}

static void ws_tee_drop(void *obj, bool gc) {
  WsTee *t = obj;
  ws_drop_obj(t->reader, gc);
  ws_drop_dyn(t->reason1, gc);
  ws_drop_dyn(t->reason2, gc);
  ws_drop_dyn(t->pending_chunk, gc);
  ws_drop_dyn(t->source_error, gc);
  ws_drop_obj(t->branch1, gc);
  ws_drop_obj(t->branch2, gc);
  ws_drop_promise(t->cancel_promise.promise, gc);
}

static const WsObjType ws_tee_type = {ws_tee_trace, ws_tee_drop};

static void ws_tee_release(WsTee *t) { ws_release(t); }

static void ws_tee_forward_chunk(void *ctx, ScrDyn *unused) {
  (void)unused;
  WsTee *t = ctx;
  t->reading = false;
  ScrDyn *value = t->pending_chunk;
  t->pending_chunk = NULL;
  if (!t->canceled1) ws_rcontroller_enqueue(t->branch1->controller, value);
  if (scr_exc_pending()) scr_exc_clear();
  if (!t->canceled2) ws_rcontroller_enqueue(t->branch2->controller, value);
  if (scr_exc_pending()) scr_exc_clear();
  scr_dyn_release(value);
}

static void ws_tee_request_chunk(WsReadRequest *q, ScrDyn *chunk) {
  WsTee *t = q->ctx;
  if (t->pending_chunk) scr_dyn_release(t->pending_chunk);
  t->pending_chunk = scr_dyn_retain(chunk);
  ws_then(ws_resolved_singleton(), ws_tee_forward_chunk, NULL, t, false); /* the request's reference moves */
  free(q);
}

static void ws_tee_close_tick(void *ctx, ScrDyn *unused) {
  (void)unused;
  WsTee *t = ctx;
  t->reading = false;
  if (!t->canceled1) ws_rcontroller_close(t->branch1->controller);
  if (!t->canceled2) ws_rcontroller_close(t->branch2->controller);
  if (!t->canceled1 || !t->canceled2) ws_deferred_resolve_undefined(&t->cancel_promise);
}

static void ws_tee_request_close(WsReadRequest *q) {
  WsTee *t = q->ctx;
  ws_next_tick(ws_tee_close_tick, t); /* the request's reference moves */
  free(q);
}

static void ws_tee_request_error(WsReadRequest *q, ScrDyn *error) {
  (void)error;
  WsTee *t = q->ctx;
  t->reading = false;
  ws_tee_release(t);
  free(q);
}

static const WsReadRequestOps ws_tee_request_ops = {ws_tee_request_chunk, ws_tee_request_close, ws_tee_request_error};

static ScrDyn *ws_tee_pull(void *ctx, WsRController *c) {
  (void)c;
  WsTee *t = ctx;
  /* `async function pullAlgorithm`: a promise fulfilled with undefined. */
  if (!t->reading) {
    t->reading = true;
    WsReadRequest *q = ws_alloc(sizeof *q);
    q->ops = &ws_tee_request_ops;
    q->ctx = ws_retain(t);
    ws_reader_read_request(t->reader, q);
  }
  ScrDyn *u = ws_undef();
  ScrPromise *p = ws_promise_resolved(u);
  scr_dyn_release(u);
  ScrDyn *box = scr_dyn_new_promise(p);
  scr_promise_release(p);
  return box;
}

static ScrPromise *ws_tee_cancel(void *ctx, WsRController *c, ScrDyn *reason) {
  WsTee *t = ctx;
  if (c->native_branch == 1) {
    t->canceled1 = true;
    t->reason1 = scr_dyn_retain(reason);
  } else {
    t->canceled2 = true;
    t->reason2 = scr_dyn_retain(reason);
  }
  if (t->canceled1 && t->canceled2) {
    ScrDyn *composite = scr_dyn_new_arr();
    scr_dyn_arr_push(composite, scr_dyn_retain(t->reason1));
    scr_dyn_arr_push(composite, scr_dyn_retain(t->reason2));
    ScrPromise *cancel = ws_readable_cancel(t->reader->stream, composite);
    scr_dyn_release(composite);
    ws_deferred_resolve_promise(&t->cancel_promise, cancel);
    scr_promise_release(cancel);
  }
  return scr_promise_retain(t->cancel_promise.promise);
}

static const WsSourceOps ws_tee_source_ops = {ws_tee_pull, ws_tee_cancel};

/* The reaction to the reader's closed promise rejecting (Node's tee). */
static void ws_tee_source_errored(void *ctx, ScrDyn *unused) {
  (void)unused;
  WsTee *t = ctx;
  ScrDyn *error = t->source_error;
  ws_rcontroller_error(t->branch1->controller, error);
  ws_rcontroller_error(t->branch2->controller, error);
  if (!t->canceled1 || !t->canceled2) ws_deferred_resolve_undefined(&t->cancel_promise);
}

/* The source stream errored: the reaction job runs where the closed
 * promise's would. */
static void ws_tee_source_error(WsTee *t, ScrDyn *error) {
  if (t->source_error) return;
  t->source_error = scr_dyn_retain(error);
  ws_queue_microtask(ws_tee_source_errored, ws_retain(t));
}

/* readableStreamDefaultTee: false with the exception pending. */
static bool ws_readable_tee(WsReadable *s, WsReadable **out1, WsReadable **out2) {
  WsReader *reader = ws_reader_new(s);
  if (!reader) return false;
  WsTee *t = ws_obj_new(sizeof *t, &ws_tee_type);
  t->reader = reader;
  ws_deferred_init(&t->cancel_promise);
  /* Each branch's controller holds the tee as its source until it clears
   * its algorithms, and the tee holds the branches. */
  t->branch1 = ws_readable_create_native(&ws_tee_source_ops, ws_retain(t), 1, 1);
  t->branch2 = ws_readable_create_native(&ws_tee_source_ops, ws_retain(t), 2, 1);
  reader->tee = ws_retain(t);
  if (s->state == WS_STATE_ERRORED) ws_tee_source_error(t, s->stored_error);
  *out1 = ws_readable_retain(t->branch1);
  *out2 = ws_readable_retain(t->branch2);
  ws_tee_release(t);
  return true;
}

/* ── ReadableStream.from (readableStreamFromIterable) ─────────────── */

typedef struct WsFrom {
  WsObj obj;
  WsReadable *stream; /* +1 until the stream clears its algorithms */
  ScrDyn *iterator;
  ScrDyn *next_method;
  ScrDyn *pending_result;
} WsFrom;

static void ws_from_trace(void *obj, ScrTraceVisit visit, void *ctx) {
  WsFrom *f = obj;
  ws_visit(f->stream, visit, ctx);
  ws_visit(f->iterator, visit, ctx);
  ws_visit(f->next_method, visit, ctx);
  ws_visit(f->pending_result, visit, ctx);
}

static void ws_from_drop(void *obj, bool gc) {
  WsFrom *f = obj;
  ws_drop_obj(f->stream, gc);
  ws_drop_dyn(f->iterator, gc);
  ws_drop_dyn(f->next_method, gc);
  ws_drop_dyn(f->pending_result, gc);
}

static const WsObjType ws_from_type = {ws_from_trace, ws_from_drop};

/* The stream's controller while it still holds this source; NULL once it
 * cleared its algorithms (closed, errored or canceled). */
static WsRController *ws_from_controller(WsFrom *f) {
  WsRController *c = f->stream->controller;
  return c->algorithms_cleared ? NULL : c;
}

static void ws_from_reject_pull(void *ctx, ScrDyn *error) {
  WsRController *c = ws_from_controller(ctx);
  if (c) ws_rcontroller_error(c, error);
}

static void ws_from_pull_fulfilled(WsFrom *f) {
  WsRController *c = ws_from_controller(f);
  if (c) ws_pull_fulfilled(c, NULL);
}

static void ws_from_enqueue_value(void *ctx, ScrDyn *value) {
  WsFrom *f = ctx;
  WsRController *c = ws_from_controller(f);
  if (!c) return;
  if (!ws_rcontroller_enqueue(c, value)) {
    ScrDyn *error = ws_take_pending();
    ws_from_reject_pull(f, error);
    scr_dyn_release(error);
    return;
  }
  ws_from_pull_fulfilled(f);
}

static void ws_from_process_result(void *ctx, ScrDyn *result) {
  WsFrom *f = ctx;
  WsRController *c = ws_from_controller(f);
  if (!c) return;
  if (!ws_is_object(result)) {
    ScrDyn *error = ws_state_error_value(
        "The promise returned by the iterator.next() method must fulfill with an object");
    ws_from_reject_pull(f, error);
    scr_dyn_release(error);
    return;
  }
  ScrDyn *done = ws_get(result, "done");
  if (!done) goto threw;
  bool finished = scr_dyn_truthy(done);
  scr_dyn_release(done);
  if (finished) {
    ws_rcontroller_close(c);
  } else {
    ScrDyn *value = ws_get(result, "value");
    if (!value) goto threw;
    if (ws_is_object(value)) {
      ScrPromise *p = ws_promise_resolve(value);
      scr_dyn_release(value);
      if (!p) goto threw;
      ws_then(p, ws_from_enqueue_value, ws_from_reject_pull, ws_retain(f), false);
      scr_promise_release(p);
      return;
    }
    bool ok = ws_rcontroller_enqueue(c, value);
    scr_dyn_release(value);
    if (!ok) goto threw;
  }
  ws_from_pull_fulfilled(f);
  return;
threw: {
  ScrDyn *error = ws_take_pending();
  ws_from_reject_pull(f, error);
  scr_dyn_release(error);
}
}

static void ws_from_process_pending(void *ctx, ScrDyn *unused) {
  (void)unused;
  WsFrom *f = ctx;
  ScrDyn *result = f->pending_result;
  f->pending_result = NULL;
  ws_from_process_result(f, result);
  scr_dyn_release(result);
}

static ScrDyn *ws_from_pull(void *ctx, WsRController *c) {
  (void)c;
  WsFrom *f = ctx;
  /* A native iterator (an array's) answers next as a member call. */
  ScrDyn *next = scr_dyn_is_callable(f->next_method)
                     ? ws_call(f->next_method, f->iterator, NULL, 0, "iterator.next")
                     : scr_dyn_invoke(f->iterator, "next", NULL, 0, "iterator.next");
  if (!next) return NULL;
  if (ws_is_object(next)) {
    ScrPromise *p = ws_promise_resolve(next);
    scr_dyn_release(next);
    if (!p) return NULL;
    ws_then(p, ws_from_process_result, ws_from_reject_pull, ws_retain(f), false);
    scr_promise_release(p);
    return WS_PARKED;
  }
  if (f->pending_result) scr_dyn_release(f->pending_result);
  f->pending_result = next;
  ws_then(ws_resolved_singleton(), ws_from_process_pending, NULL, ws_retain(f), false);
  return WS_PARKED;
}

/* `async function cancelAlgorithm(reason)`: awaits iterator.return. */
typedef struct WsFromCancel {
  WsObj obj;
  WsDeferred result;
} WsFromCancel;

static void ws_from_cancel_trace(void *obj, ScrTraceVisit visit, void *ctx) {
  ws_visit(((WsFromCancel *)obj)->result.promise, visit, ctx);
}

static void ws_from_cancel_drop(void *obj, bool gc) { ws_drop_promise(((WsFromCancel *)obj)->result.promise, gc); }

static const WsObjType ws_from_cancel_type = {ws_from_cancel_trace, ws_from_cancel_drop};

static void ws_from_cancel_returned(void *ctx, ScrDyn *iter_result) {
  WsDeferred *d = &((WsFromCancel *)ctx)->result;
  if (!ws_is_object(iter_result)) {
    ScrDyn *error = ws_state_error_value(
        "The promise returned by the iterator.return() method must fulfill with an object");
    ws_deferred_reject(d, error);
    scr_dyn_release(error);
    return;
  }
  ws_deferred_resolve_undefined(d);
}

static void ws_from_cancel_failed(void *ctx, ScrDyn *error) {
  ws_deferred_reject(&((WsFromCancel *)ctx)->result, error);
}

static ScrPromise *ws_from_cancel(void *ctx, WsRController *c, ScrDyn *reason) {
  (void)c;
  WsFrom *f = ctx;
  ScrDyn *method = ws_get(f->iterator, "return");
  if (!method) return ws_promise_rejected_pending();
  if (method->kind == SCR_DYN_UNDEF) {
    scr_dyn_release(method);
    ScrDyn *u = ws_undef();
    ScrPromise *p = ws_promise_resolved(u);
    scr_dyn_release(u);
    return p;
  }
  ScrDyn *returned = ws_call(method, f->iterator, &reason, 1, "iterator.return");
  scr_dyn_release(method);
  if (!returned) return ws_promise_rejected_pending();
  /* `await returned`, then the check. */
  ScrPromise *awaited = ws_promise_resolve(returned);
  scr_dyn_release(returned);
  if (!awaited) return ws_promise_rejected_pending();
  WsFromCancel *wait = ws_obj_new(sizeof *wait, &ws_from_cancel_type);
  ws_deferred_init(&wait->result);
  ScrPromise *result = scr_promise_retain(wait->result.promise);
  ws_then(awaited, ws_from_cancel_returned, ws_from_cancel_failed, wait, false);
  scr_promise_release(awaited);
  return result;
}

static const WsSourceOps ws_from_source_ops = {ws_from_pull, ws_from_cancel};

static ScrDyn *ws_readable_from(ScrDyn *iterable) {
  /* `iterable[SymbolAsyncIterator]` on undefined or null. */
  if (iterable->kind == SCR_DYN_UNDEF || iterable->kind == SCR_DYN_NULL) {
    char buf[96];
    int n = snprintf(buf, sizeof buf, "Cannot read properties of %s (reading 'Symbol(Symbol.asyncIterator)')",
                     iterable->kind == SCR_DYN_NULL ? "null" : "undefined");
    scr_throw_error_msg(SCR_ERR_TYPE, buf, (size_t)n);
    return NULL;
  }
  int kind = 0;
  ScrDyn *iterator = scr_dyn_open_iterator(iterable, &kind, true);
  if (kind < 0) return NULL;
  if (!iterator) {
    /* ERR_ARG_NOT_ITERABLE's '%s must be iterable', which renders a
     * function by its source text. */
    if (scr_dyn_is_callable(iterable)) {
      static const char message[] = "ReadableStream.from of a function that is not iterable is not supported yet";
      scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
      return NULL;
    }
    ScrStr *text = scr_insp_dyn_format_s(iterable, 0);
    if (!text) return NULL;
    size_t n = text->len + 17;
    char *buf = malloc(n);
    if (!buf) ws_oom();
    memcpy(buf, text->data, text->len);
    memcpy(buf + text->len, " must be iterable", 17);
    scr_str_release(text);
    scr_throw_error_msg_code(SCR_ERR_TYPE, buf, n, "ERR_ARG_NOT_ITERABLE");
    free(buf);
    return NULL;
  }
  if (!ws_is_object(iterator)) {
    scr_dyn_release(iterator);
    ws_state_error("The iterator method must return an object");
    return NULL;
  }
  ScrDyn *next = ws_get(iterator, "next");
  if (!next) {
    scr_dyn_release(iterator);
    return NULL;
  }
  WsFrom *f = ws_obj_new(sizeof *f, &ws_from_type);
  f->iterator = iterator;
  f->next_method = next;
  WsReadable *s = ws_readable_create_native(&ws_from_source_ops, f, 0, 0);
  f->stream = ws_readable_retain(s);
  ScrDyn *box = ws_stream_box(s);
  ws_readable_release(s);
  return box;
}

static ScrDyn *ws_readable_from_thunk(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure;
  return ws_readable_from(argc > 0 ? args[0] : scr_dyn_undefined());
}

/* ── async iteration (ReadableStream.prototype.values) ────────────── */

typedef struct WsIter {
  WsObj obj;
  WsReader *reader;
  bool done, started, prevent_cancel;
  ScrPromise *current; /* state.current, +1 when set */
} WsIter;

static void ws_iter_trace(void *obj, ScrTraceVisit visit, void *ctx) {
  WsIter *it = obj;
  ws_visit(it->reader, visit, ctx);
  ws_visit(it->current, visit, ctx);
}

static void ws_iter_drop(void *obj, bool gc) {
  WsIter *it = obj;
  ws_drop_obj(it->reader, gc);
  ws_drop_promise(it->current, gc);
}

static const WsObjType ws_iter_type = {ws_iter_trace, ws_iter_drop};

static void ws_iter_release(WsIter *it) { ws_release(it); }

static void ws_iter_set_current(WsIter *it, ScrPromise *p) {
  if (it->current) scr_promise_release(it->current);
  it->current = p;
}

static ScrDyn *ws_iter_result(bool done, ScrDyn *value) {
  ScrDyn *result = scr_dyn_new_obj();
  scr_dyn_obj_set(result, "done", 4, scr_dyn_new_bool(done));
  scr_dyn_obj_set(result, "value", 5, scr_dyn_retain(value));
  return result;
}

static void ws_iter_chunk(WsReadRequest *q, ScrDyn *chunk) {
  WsIter *it = q->ctx;
  ws_iter_set_current(it, NULL);
  ScrDyn *result = ws_read_result(chunk, false);
  ws_fulfill(q->promise, result);
  scr_dyn_release(result);
  scr_promise_release(q->promise);
  ws_iter_release(it);
  free(q);
}

static void ws_iter_close(WsReadRequest *q) {
  WsIter *it = q->ctx;
  ws_iter_set_current(it, NULL);
  it->done = true;
  if (it->reader->stream) ws_reader_generic_release(it->reader);
  ScrDyn *u = ws_undef();
  ScrDyn *result = ws_iter_result(true, u);
  scr_dyn_release(u);
  ws_fulfill(q->promise, result);
  scr_dyn_release(result);
  scr_promise_release(q->promise);
  ws_iter_release(it);
  free(q);
}

static void ws_iter_error(WsReadRequest *q, ScrDyn *error) {
  WsIter *it = q->ctx;
  ws_iter_set_current(it, NULL);
  it->done = true;
  if (it->reader->stream) ws_reader_generic_release(it->reader);
  ws_reject(q->promise, error);
  scr_promise_release(q->promise);
  ws_iter_release(it);
  free(q);
}

static const WsReadRequestOps ws_iter_request_ops = {ws_iter_chunk, ws_iter_close, ws_iter_error};

/* nextSteps: +1 promise. */
static ScrPromise *ws_iter_next_steps(void *ctx, ScrDyn *unused) {
  (void)unused;
  WsIter *it = ctx;
  if (it->done) {
    ScrDyn *u = ws_undef();
    ScrDyn *result = ws_iter_result(true, u);
    scr_dyn_release(u);
    ScrPromise *p = ws_promise_resolved(result);
    scr_dyn_release(result);
    return p;
  }
  if (!it->reader->stream) {
    ScrDyn *error = ws_state_error_value("The reader is not bound to a ReadableStream");
    ScrPromise *p = ws_promise_rejected(error);
    scr_dyn_release(error);
    return p;
  }
  WsReadRequest *q = ws_alloc(sizeof *q);
  q->ops = &ws_iter_request_ops;
  q->promise = scr_promise_new();
  q->ctx = ws_retain(it);
  ScrPromise *result = scr_promise_retain(q->promise);
  ws_reader_read_request(it->reader, q);
  return result;
}

/* The read() and next() fast path: a queued chunk, dequeued now. */
static bool ws_dequeue_fast(WsReadable *s, ScrDyn **chunk_out) {
  if (!s || s->state != WS_STATE_READABLE) return false;
  WsRController *c = s->controller;
  if (!c->queue.length) return false;
  s->disturbed = true;
  double size;
  ScrDyn *chunk = ws_queue_shift(&c->queue, &size);
  c->queue_total_size = fmax(0, c->queue_total_size - size);
  if (c->close_requested && !c->queue.length) {
    ws_rcontroller_clear_algorithms(c);
    ws_readable_close(s);
  } else if (!c->close_requested && c->started && c->high_water_mark - c->queue_total_size > 0) {
    ws_rcontroller_pull(c);
  }
  *chunk_out = chunk;
  return true;
}

static WsIter *ws_iter_of(ScrClosure *closure) { return scr_box_get_ref(closure->caps[0]); }

static ScrDyn *ws_iter_next(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)args;
  (void)argc;
  WsIter *it = ws_iter_of(closure);
  ScrPromise *result;
  if (!it->started) {
    ScrDyn *u = ws_undef();
    ws_iter_set_current(it, ws_promise_resolved(u));
    scr_dyn_release(u);
    it->started = true;
  }
  ScrDyn *chunk;
  if (it->current) {
    ScrPromise *chained = ws_then_adopt(it->current, ws_iter_next_steps, ws_iter_next_steps, ws_retain(it));
    ws_iter_set_current(it, chained);
    result = scr_promise_retain(chained);
  } else if (!it->done && ws_dequeue_fast(it->reader->stream, &chunk)) {
    ScrDyn *record = ws_read_result(chunk, false);
    scr_dyn_release(chunk);
    result = ws_promise_resolved(record);
    scr_dyn_release(record);
  } else {
    result = ws_iter_next_steps(it, NULL);
    ws_iter_set_current(it, scr_promise_retain(result));
  }
  ws_iter_release(it);
  ScrDyn *box = scr_dyn_new_promise(result);
  scr_promise_release(result);
  return box;
}

/* returnSteps(value): `async function`, so the result is a promise. */
typedef struct WsIterReturn {
  WsObj obj;
  WsIter *it;
  ScrDyn *value;
} WsIterReturn;

static void ws_iter_return_trace(void *obj, ScrTraceVisit visit, void *ctx) {
  WsIterReturn *r = obj;
  ws_visit(r->it, visit, ctx);
  ws_visit(r->value, visit, ctx);
}

static void ws_iter_return_drop(void *obj, bool gc) {
  WsIterReturn *r = obj;
  ws_drop_obj(r->it, gc);
  ws_drop_dyn(r->value, gc);
}

static const WsObjType ws_iter_return_type = {ws_iter_return_trace, ws_iter_return_drop};

/* `await result; return record` inside returnSteps. */
typedef struct WsAwaitReturn {
  WsObj obj;
  ScrPromise *out;
  ScrDyn *record;
} WsAwaitReturn;

static void ws_await_return_trace(void *obj, ScrTraceVisit visit, void *ctx) {
  WsAwaitReturn *a = obj;
  ws_visit(a->out, visit, ctx);
  ws_visit(a->record, visit, ctx);
}

static void ws_await_return_drop(void *obj, bool gc) {
  WsAwaitReturn *a = obj;
  ws_drop_promise(a->out, gc);
  ws_drop_dyn(a->record, gc);
}

static const WsObjType ws_await_return_type = {ws_await_return_trace, ws_await_return_drop};

static void ws_await_return_ok(void *ctx, ScrDyn *unused) {
  (void)unused;
  WsAwaitReturn *a = ctx;
  ws_fulfill(a->out, a->record);
}

static void ws_await_return_err(void *ctx, ScrDyn *reason) {
  WsAwaitReturn *a = ctx;
  ws_reject(a->out, reason);
}

static ScrPromise *ws_iter_return_steps(WsIter *it, ScrDyn *value) {
  ScrDyn *record = ws_iter_result(true, value);
  ScrPromise *out;
  if (it->done) {
    out = ws_promise_resolved(record);
    scr_dyn_release(record);
    return out;
  }
  it->done = true;
  if (!it->reader->stream) {
    scr_dyn_release(record);
    ScrDyn *error = ws_state_error_value("The reader is not bound to a ReadableStream");
    out = ws_promise_rejected(error);
    scr_dyn_release(error);
    return out;
  }
  if (!it->prevent_cancel) {
    ScrPromise *cancel = ws_readable_cancel(it->reader->stream, value);
    ws_reader_generic_release(it->reader);
    WsAwaitReturn *a = ws_obj_new(sizeof *a, &ws_await_return_type);
    out = scr_promise_new();
    a->out = scr_promise_retain(out);
    a->record = record;
    ws_then(cancel, ws_await_return_ok, ws_await_return_err, a, false);
    scr_promise_release(cancel);
    return out;
  }
  ws_reader_generic_release(it->reader);
  out = ws_promise_resolved(record);
  scr_dyn_release(record);
  return out;
}

static ScrPromise *ws_iter_return_pstep(void *ctx, ScrDyn *unused) {
  (void)unused;
  WsIterReturn *r = ctx;
  return ws_iter_return_steps(r->it, r->value);
}

static ScrDyn *ws_iter_return(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  WsIter *it = ws_iter_of(closure);
  ScrDyn *value = argc > 0 ? args[0] : scr_dyn_undefined();
  it->started = true;
  ScrPromise *result;
  if (it->current) {
    WsIterReturn *r = ws_obj_new(sizeof *r, &ws_iter_return_type);
    r->it = ws_retain(it);
    r->value = scr_dyn_retain(value);
    result = ws_then_adopt(it->current, ws_iter_return_pstep, ws_iter_return_pstep, r);
  } else {
    result = ws_iter_return_steps(it, value);
  }
  ws_iter_set_current(it, scr_promise_retain(result));
  ws_iter_release(it);
  ScrDyn *box = scr_dyn_new_promise(result);
  scr_promise_release(result);
  return box;
}

static ScrDyn *ws_iter_method(WsIter *it, ScrDynThunk thunk, const char *name) {
  ScrClosure *closure = scr_closure_new(NULL, 1);
  /* A box with a trace visits its payload, which carries a header. */
  closure->caps[0] = scr_box_new_obj(ws_retain, ws_release, ws_obj_trace);
  scr_box_set_ref(closure->caps[0], ws_retain(it));
  return scr_dyn_new_func(closure, thunk, 0, "", name);
}

static ScrDyn *ws_self_thunk(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure;
  (void)args;
  (void)argc;
  return scr_dyn_this_get();
}

/* values(options): the async iterator object, +1. */
static ScrDyn *ws_readable_values(WsReadable *s, ScrDyn *options) {
  if (!ws_validate_object(options, "options", true)) return NULL;
  ScrDyn *prevent = ws_get(options, "preventCancel");
  if (!prevent) return NULL;
  bool prevent_cancel = scr_dyn_truthy(prevent);
  scr_dyn_release(prevent);
  WsReader *reader = ws_reader_new(s);
  if (!reader) return NULL;
  WsIter *it = ws_obj_new(sizeof *it, &ws_iter_type);
  it->reader = reader;
  it->prevent_cancel = prevent_cancel;
  ScrDyn *object = scr_dyn_new_obj();
  scr_dyn_obj_set(object, "next", 4, ws_iter_method(it, ws_iter_next, "next"));
  scr_dyn_obj_set(object, "return", 6, ws_iter_method(it, ws_iter_return, "return"));
  ScrDyn *self_fn = scr_dyn_new_func(scr_closure_new(NULL, 0), ws_self_thunk, 0, "", "[Symbol.asyncIterator]");
  ScrDyn *key = scr_dyn_async_iterator_symbol_value();
  if (key) {
    scr_dyn_symbol_key_set(object, key, self_fn);
    scr_dyn_release(key);
  }
  scr_dyn_release(self_fn);
  ws_iter_release(it);
  return object;
}

/* ── sink read requests (Readable.fromWeb) ─────────────────────────── */

typedef struct WsSinkRequest {
  WsReadRequest base;
  const ScrFetchReadSink *sink;
  void *sink_ctx;
} WsSinkRequest;

static void ws_sink_chunk(WsReadRequest *q, ScrDyn *chunk) {
  WsSinkRequest *r = (WsSinkRequest *)q;
  r->sink->chunk(r->sink_ctx, chunk);
  free(r);
}

static void ws_sink_close(WsReadRequest *q) {
  WsSinkRequest *r = (WsSinkRequest *)q;
  r->sink->close(r->sink_ctx);
  free(r);
}

static void ws_sink_error(WsReadRequest *q, ScrDyn *error) {
  WsSinkRequest *r = (WsSinkRequest *)q;
  r->sink->error(r->sink_ctx, error);
  free(r);
}

static const WsReadRequestOps ws_sink_request_ops = {ws_sink_chunk, ws_sink_close, ws_sink_error};

static bool ws_reader_read_into(ScrDyn *reader, const ScrFetchReadSink *sink, void *ctx) {
  WsReader *r = reader->v.handle.ptr;
  if (!r->stream) {
    ws_state_error("The reader is not attached to a stream");
    return false;
  }
  WsSinkRequest *q = ws_alloc(sizeof *q);
  q->base.ops = &ws_sink_request_ops;
  q->sink = sink;
  q->sink_ctx = ctx;
  ws_reader_read_request(r, &q->base);
  return true;
}

/* A stream that cannot be a Response or Request body. */
static bool ws_readable_unusable(const ScrDyn *stream) {
  WsReadable *s = ws_stream_of(stream);
  return !s || ws_readable_locked(s) || s->disturbed;
}

static const ScrWebStreamBridge ws_fetch_bridge = {ws_reader_read_into, ws_readable_unusable};

/* ── the handle surfaces ───────────────────────────────────────────── */

static bool ws_name(const char *key, size_t len, const char *want) {
  return strlen(want) == len && memcmp(key, want, len) == 0;
}

/* A member call of a name that is no method of the class: the member's
 * value (an accessor such as a strategy's size), called with the handle as
 * its receiver; "<what> is not a function" when it is not callable. */
static ScrDyn *ws_invoke_member(ScrDyn *self, const char *method, ScrDyn *const *args, size_t argc,
                                const char *what) {
  ScrStr *key = scr_str_new(method, strlen(method));
  ScrDyn *member = scr_dyn_handle_key_get(self, key);
  scr_str_release(key);
  if (!member) return NULL;
  if (!scr_dyn_is_callable(member)) {
    scr_dyn_release(member);
    char buf[256];
    int n = snprintf(buf, sizeof buf, "%s is not a function", what && *what ? what : method);
    scr_throw_error_msg(SCR_ERR_TYPE, buf, (size_t)n);
    return NULL;
  }
  ScrDyn *result = ws_call(member, self, args, argc, what);
  scr_dyn_release(member);
  return result;
}

static ScrDyn *ws_arg(ScrDyn *const *args, size_t argc, size_t i) {
  return i < argc ? args[i] : scr_dyn_undefined();
}

static ScrDyn *ws_promise_box(ScrPromise *p) {
  ScrDyn *box = scr_dyn_new_promise(p);
  scr_promise_release(p);
  return box;
}

static ScrDyn *ws_rejected_pending_box(void) { return ws_promise_box(ws_promise_rejected_pending()); }

/* ReadableStream */

static ScrDyn *ws_readable_get_reader(WsReadable *s, ScrDyn *options) {
  if (!ws_validate_object(options, "options", true)) return NULL;
  ScrDyn *mode = ws_get(options, "mode");
  if (!mode) return NULL;
  if (mode->kind != SCR_DYN_UNDEF) {
    ScrStr *text = scr_dyn_string_coerce_js(mode);
    if (!text) {
      scr_dyn_release(mode);
      return NULL;
    }
    bool byob = text->len == 4 && memcmp(text->data, "byob", 4) == 0;
    scr_str_release(text);
    if (byob) {
      scr_dyn_release(mode);
      static const char message[] = "ReadableStreamBYOBReader is not supported yet";
      scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
      return NULL;
    }
    scr_dyn_arg_value_fail("options.mode", NULL, mode);
    scr_dyn_release(mode);
    return NULL;
  }
  scr_dyn_release(mode);
  WsReader *r = ws_reader_new(s);
  if (!r) return NULL;
  ScrDyn *box = ws_reader_box(r);
  ws_reader_release(r);
  return box;
}

static ScrDyn *ws_readable_invoke(void *ptr, ScrDyn *self, const char *method, ScrDyn *const *args, size_t argc,
                                  const char *what) {
  (void)self;
  (void)what;
  WsReadable *s = ptr;
  size_t len = strlen(method);
  if (ws_name(method, len, "cancel")) {
    if (ws_readable_locked(s)) {
      ScrDyn *error = ws_state_error_value("ReadableStream is locked");
      ScrPromise *p = ws_promise_rejected(error);
      scr_dyn_release(error);
      return ws_promise_box(p);
    }
    return ws_promise_box(ws_readable_cancel(s, ws_arg(args, argc, 0)));
  }
  if (ws_name(method, len, "getReader")) {
    ScrDyn *options = ws_arg(args, argc, 0);
    ScrDyn *empty = options->kind == SCR_DYN_UNDEF ? scr_dyn_new_obj() : NULL;
    ScrDyn *reader = ws_readable_get_reader(s, empty ? empty : options);
    if (empty) scr_dyn_release(empty);
    return reader;
  }
  if (ws_name(method, len, "tee")) {
    WsReadable *a, *b;
    if (!ws_readable_tee(s, &a, &b)) return NULL;
    ScrDyn *pair = scr_dyn_new_arr();
    scr_dyn_arr_push(pair, ws_stream_box(a));
    scr_dyn_arr_push(pair, ws_stream_box(b));
    ws_readable_release(a);
    ws_readable_release(b);
    return pair;
  }
  if (ws_name(method, len, "values")) {
    ScrDyn *options = ws_arg(args, argc, 0);
    ScrDyn *empty = options->kind == SCR_DYN_UNDEF ? scr_dyn_new_obj() : NULL;
    ScrDyn *iterator = ws_readable_values(s, empty ? empty : options);
    if (empty) scr_dyn_release(empty);
    return iterator;
  }
  if (ws_name(method, len, "pipeTo") || ws_name(method, len, "pipeThrough")) {
    static const char message[] = "ReadableStream.prototype.pipeTo and pipeThrough are not supported yet";
    scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
    return NULL;
  }
  return ws_invoke_member(self, method, args, argc, what);
}

static ScrDyn *ws_readable_get(void *ptr, const char *key, size_t len) {
  WsReadable *s = ptr;
  if (ws_name(key, len, "locked")) return scr_dyn_new_bool(ws_readable_locked(s));
  return scr_dyn_handle_class_member(SCR_DYNH_WS_READABLE, ptr, key, len);
}

/* Symbol.asyncIterator is values. */
static ScrDyn *ws_readable_symbol_get(void *ptr, const ScrDyn *key) {
  (void)ptr;
  if (!scr_dyn_is_async_iterator_symbol(key)) return NULL;
  return scr_dyn_handle_class_method(SCR_DYNH_WS_READABLE, "values");
}

static ScrDyn *ws_rejected_value(void) { return ws_rejected_pending_box(); }

static const ScrDynHandleMethod ws_readable_methods[] = {
    {"cancel", 0, true, NULL}, {"getReader", 0, false, NULL}, {"pipeThrough", 1, false, NULL},
    {"pipeTo", 1, true, NULL}, {"tee", 0, false, NULL},       {"values", 0, false, NULL},
    {NULL, 0, false, NULL},
};

static const ScrDynHandleAccessor ws_readable_accessors[] = {{"locked", false}, {NULL, false}};

static const ScrDynHandleStatic ws_readable_statics[] = {{"from", 1, ws_readable_from_thunk}, {NULL, 0, NULL}};

static const char *const ws_readable_order[] = {"locked", "cancel", "getReader", "pipeThrough", "pipeTo",
                                                "tee",    "values", NULL};

static const ScrDynHandleClass ws_readable_class = {
    "ReadableStream", 0, ws_readable_construct, ws_readable_accessors, ws_readable_statics, ws_readable_order,
};

/* ReadableStreamDefaultReader */

static ScrDyn *ws_reader_construct(ScrDyn *const *args, size_t argc) {
  ScrDyn *stream = ws_arg(args, argc, 0);
  WsReadable *s = ws_stream_of(stream);
  if (!s) {
    scr_dyn_arg_type_fail("stream", "an instance of ReadableStream", stream);
    return NULL;
  }
  WsReader *r = ws_reader_new(s);
  if (!r) return NULL;
  ScrDyn *box = ws_reader_box(r);
  ws_reader_release(r);
  return box;
}

static ScrDyn *ws_reader_detached(void) {
  ScrDyn *error = ws_state_error_value("The reader is not attached to a stream");
  ScrPromise *p = ws_promise_rejected(error);
  scr_dyn_release(error);
  return ws_promise_box(p);
}

static ScrDyn *ws_reader_read(WsReader *r) {
  if (!r->stream) return ws_reader_detached();
  ScrDyn *chunk;
  if (ws_dequeue_fast(r->stream, &chunk)) {
    ScrDyn *record = ws_read_result(chunk, false);
    scr_dyn_release(chunk);
    ScrPromise *p = ws_promise_resolved(record);
    scr_dyn_release(record);
    return ws_promise_box(p);
  }
  WsReadRequest *q = ws_alloc(sizeof *q);
  q->ops = &ws_default_request_ops;
  q->promise = scr_promise_new();
  ScrPromise *result = scr_promise_retain(q->promise);
  ws_reader_read_request(r, q);
  return ws_promise_box(result);
}

static ScrDyn *ws_reader_invoke(void *ptr, ScrDyn *self, const char *method, ScrDyn *const *args, size_t argc,
                                const char *what) {
  (void)self;
  (void)what;
  WsReader *r = ptr;
  size_t len = strlen(method);
  if (ws_name(method, len, "read")) return ws_reader_read(r);
  if (ws_name(method, len, "releaseLock")) {
    if (r->stream) ws_reader_release_lock(r);
    return ws_undef();
  }
  if (ws_name(method, len, "cancel")) {
    if (!r->stream) return ws_reader_detached();
    return ws_promise_box(ws_readable_cancel(r->stream, ws_arg(args, argc, 0)));
  }
  return ws_invoke_member(self, method, args, argc, what);
}

static ScrDyn *ws_reader_get(void *ptr, const char *key, size_t len) {
  WsReader *r = ptr;
  if (ws_name(key, len, "closed")) return scr_dyn_new_promise(ws_reader_closed_promise(r));
  return scr_dyn_handle_class_member(SCR_DYNH_WS_READER, ptr, key, len);
}

static const ScrDynHandleMethod ws_reader_methods[] = {
    {"read", 0, true, NULL}, {"releaseLock", 0, false, NULL}, {"cancel", 0, true, NULL}, {NULL, 0, false, NULL},
};

static const ScrDynHandleAccessor ws_reader_accessors[] = {{"closed", true}, {NULL, false}};

static const char *const ws_reader_order[] = {"read", "releaseLock", "closed", "cancel", NULL};

static const ScrDynHandleClass ws_reader_class = {
    "ReadableStreamDefaultReader", 1, ws_reader_construct, ws_reader_accessors, NULL, ws_reader_order,
};

/* ReadableStreamDefaultController */

static ScrDyn *ws_rcontroller_invoke(void *ptr, ScrDyn *self, const char *method, ScrDyn *const *args,
                                     size_t argc, const char *what) {
  (void)self;
  (void)what;
  WsRController *c = ptr;
  size_t len = strlen(method);
  if (ws_name(method, len, "close")) {
    if (!ws_rcontroller_can_close_or_enqueue(c)) {
      ws_state_error("Controller is already closed");
      return NULL;
    }
    ws_rcontroller_close(c);
    return ws_undef();
  }
  if (ws_name(method, len, "enqueue")) {
    if (!ws_rcontroller_can_close_or_enqueue(c)) {
      ws_state_error("Controller is already closed");
      return NULL;
    }
    if (!ws_rcontroller_enqueue(c, ws_arg(args, argc, 0))) return NULL;
    return ws_undef();
  }
  if (ws_name(method, len, "error")) {
    ws_rcontroller_error(c, ws_arg(args, argc, 0));
    return ws_undef();
  }
  return ws_invoke_member(self, method, args, argc, what);
}

static ScrDyn *ws_rcontroller_get(void *ptr, const char *key, size_t len) {
  if (ws_name(key, len, "desiredSize")) return ws_rcontroller_desired_size(ptr);
  return scr_dyn_handle_class_member(SCR_DYNH_WS_RCONTROLLER, ptr, key, len);
}

static const ScrDynHandleMethod ws_rcontroller_methods[] = {
    {"close", 0, false, NULL}, {"enqueue", 0, false, NULL}, {"error", 0, false, NULL}, {NULL, 0, false, NULL},
};

static const ScrDynHandleAccessor ws_rcontroller_accessors[] = {{"desiredSize", false}, {NULL, false}};

static const char *const ws_rcontroller_order[] = {"desiredSize", "close", "enqueue", "error", NULL};

static const ScrDynHandleClass ws_rcontroller_class = {
    "ReadableStreamDefaultController", 0, NULL, ws_rcontroller_accessors, NULL, ws_rcontroller_order,
};

/* ── queuing strategies ────────────────────────────────────────────── */

typedef struct WsStrategy {
  size_t rc;
  bool bytes;
  double high_water_mark;
} WsStrategy;

static void *ws_strategy_retain(void *p) {
  ((WsStrategy *)p)->rc++;
  return p;
}
static void ws_strategy_release(void *p) {
  WsStrategy *q = p;
  if (--q->rc == 0) free(q);
}

static ScrDyn *ws_count_size(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure;
  (void)args;
  (void)argc;
  return scr_dyn_new_num(1);
}

/* (chunk) => chunk.byteLength */
static ScrDyn *ws_byte_size(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure;
  return ws_get(ws_arg(args, argc, 0), "byteLength");
}

static SCR_TL ScrDyn *ws_size_functions[2];

static void ws_size_functions_teardown(void) {
  for (int i = 0; i < 2; i++) {
    if (ws_size_functions[i]) scr_dyn_release(ws_size_functions[i]);
    ws_size_functions[i] = NULL;
  }
}

static ScrDyn *ws_size_function(bool bytes) {
  int i = bytes ? 1 : 0;
  if (!ws_size_functions[i]) {
    if (!ws_size_functions[0] && !ws_size_functions[1]) scr_atexit(ws_size_functions_teardown);
    ws_size_functions[i] = scr_dyn_new_func(scr_closure_new(NULL, 0), bytes ? ws_byte_size : ws_count_size,
                                            bytes ? 1 : 0, "", "size");
  }
  return scr_dyn_retain(ws_size_functions[i]);
}

static ScrDyn *ws_strategy_construct(ScrDyn *const *args, size_t argc, bool bytes) {
  ScrDyn *init = ws_arg(args, argc, 0);
  /* validateObject without options: arrays and functions are refused too. */
  if (init->kind == SCR_DYN_ARR || init->kind == SCR_DYN_FUNC || !ws_validate_object(init, "init", false)) {
    if (!scr_exc_pending()) scr_dyn_arg_type_fail("init", "of type object", init);
    return NULL;
  }
  ScrDyn *hwm = ws_get(init, "highWaterMark");
  if (!hwm) return NULL;
  if (hwm->kind == SCR_DYN_UNDEF) {
    scr_dyn_release(hwm);
    static const char message[] = "init.highWaterMark is required";
    scr_throw_error_msg_code(SCR_ERR_TYPE, message, sizeof message - 1, "ERR_MISSING_OPTION");
    return NULL;
  }
  double value = scr_dyn_number_coerce(hwm);
  scr_dyn_release(hwm);
  if (scr_exc_pending()) return NULL;
  ws_install();
  WsStrategy *q = ws_alloc(sizeof *q);
  q->rc = 1;
  q->bytes = bytes;
  q->high_water_mark = value;
  ScrDyn *box = scr_dyn_new_handle(q, bytes ? SCR_DYNH_WS_BYTE_STRATEGY : SCR_DYNH_WS_COUNT_STRATEGY);
  ws_strategy_release(q);
  return box;
}

static ScrDyn *ws_count_strategy_construct(ScrDyn *const *args, size_t argc) {
  return ws_strategy_construct(args, argc, false);
}

static ScrDyn *ws_byte_strategy_construct(ScrDyn *const *args, size_t argc) {
  return ws_strategy_construct(args, argc, true);
}

static ScrDyn *ws_strategy_get(void *ptr, const char *key, size_t len) {
  WsStrategy *q = ptr;
  if (ws_name(key, len, "highWaterMark")) return scr_dyn_new_num(q->high_water_mark);
  if (ws_name(key, len, "size")) return ws_size_function(q->bytes);
  return scr_dyn_handle_class_member(q->bytes ? SCR_DYNH_WS_BYTE_STRATEGY : SCR_DYNH_WS_COUNT_STRATEGY, ptr, key, len);
}

static ScrDyn *ws_strategy_invoke(void *ptr, ScrDyn *self, const char *method, ScrDyn *const *args, size_t argc,
                                  const char *what) {
  (void)ptr;
  return ws_invoke_member(self, method, args, argc, what);
}

static const ScrDynHandleAccessor ws_strategy_accessors[] = {{"highWaterMark", false}, {"size", false}, {NULL, false}};

static const ScrDynHandleClass ws_count_strategy_class = {
    "CountQueuingStrategy", 1, ws_count_strategy_construct, ws_strategy_accessors, NULL, NULL,
};

static const ScrDynHandleClass ws_byte_strategy_class = {
    "ByteLengthQueuingStrategy", 1, ws_byte_strategy_construct, ws_strategy_accessors, NULL, NULL,
};

/* ── installation and the compiler's entry points ─────────────────── */

static bool ws_set_noop(void *h, const char *key, size_t len, const ScrDyn *value) {
  (void)h;
  (void)key;
  (void)len;
  (void)value;
  return false;
}

#define WS_OPS(NAME, CLS, RETAIN, RELEASE, INVOKE, GET, METHODS, INVALID) \
  static const ScrDynHandleOps NAME = {                                           \
      .cls = CLS,                                                                 \
      .retain = RETAIN,                                                           \
      .release = RELEASE,                                                         \
      .invoke = INVOKE,                                                           \
      .get = GET,                                                                 \
      .set = ws_set_noop,                                                         \
      .json_empty_object = true,                                                  \
      .to_string_tag = CLS,                                                       \
      .methods = METHODS,                                                         \
      .invalid_this = INVALID,                                                    \
      .rejected = ws_rejected_value,                                              \
  }

static const ScrDynHandleOps ws_readable_ops = {
    .cls = "ReadableStream",
    .retain = ws_retain,
    .release = ws_release,
    .invoke = ws_readable_invoke,
    .get = ws_readable_get,
    .set = ws_set_noop,
    .json_empty_object = true,
    .to_string_tag = "ReadableStream",
    .symbol_get = ws_readable_symbol_get,
    .methods = ws_readable_methods,
    .invalid_this = "Value of \"this\" must be of type ReadableStream",
    .rejected = ws_rejected_value,
};

WS_OPS(ws_reader_ops, "ReadableStreamDefaultReader", ws_retain, ws_release, ws_reader_invoke,
       ws_reader_get, ws_reader_methods,
       "Value of \"this\" must be of type ReadableStreamDefaultReader");
WS_OPS(ws_rcontroller_ops, "ReadableStreamDefaultController", ws_retain, ws_release,
       ws_rcontroller_invoke, ws_rcontroller_get, ws_rcontroller_methods,
       "Value of \"this\" must be of type ReadableStreamDefaultController");
WS_OPS(ws_count_strategy_ops, "CountQueuingStrategy", ws_strategy_retain, ws_strategy_release, ws_strategy_invoke,
       ws_strategy_get, NULL, "Value of \"this\" must be of type CountQueuingStrategy");
WS_OPS(ws_byte_strategy_ops, "ByteLengthQueuingStrategy", ws_strategy_retain, ws_strategy_release,
       ws_strategy_invoke, ws_strategy_get, NULL,
       "Value of \"this\" must be of type ByteLengthQueuingStrategy");

static SCR_TL bool ws_installed;

static void ws_install(void) {
  if (ws_installed) return;
  ws_installed = true;
  /* Symbol.asyncIterator, which the streams answer async iteration by
   * (scr_dyn_iterable_kind, for await). */
  ScrStr *name = scr_str_new("asyncIterator", 13);
  scr_sym_release(scr_sym_well_known(name));
  scr_str_release(name);
  scr_web_stream_bridge = &ws_fetch_bridge;
  scr_dyn_handle_class_install(SCR_DYNH_WS_READABLE, &ws_readable_ops, &ws_readable_class);
  scr_dyn_handle_class_install(SCR_DYNH_WS_READER, &ws_reader_ops, &ws_reader_class);
  scr_dyn_handle_class_install(SCR_DYNH_WS_RCONTROLLER, &ws_rcontroller_ops, &ws_rcontroller_class);
  scr_dyn_handle_class_install(SCR_DYNH_WS_COUNT_STRATEGY, &ws_count_strategy_ops, &ws_count_strategy_class);
  scr_dyn_handle_class_install(SCR_DYNH_WS_BYTE_STRATEGY, &ws_byte_strategy_ops, &ws_byte_strategy_class);
  /* The fetch unit's streams, readers and controllers (a Response body)
   * are instances of the same classes. */
  scr_dyn_handle_class_alias(SCR_DYNH_WEB_STREAM, SCR_DYNH_WS_READABLE);
  scr_dyn_handle_class_alias(SCR_DYNH_WEB_READER, SCR_DYNH_WS_READER);
  scr_dyn_handle_class_alias(SCR_DYNH_WEB_CONTROLLER, SCR_DYNH_WS_RCONTROLLER);
}

/* The classes in the frontend's WEB_STREAM_CLASSES order. */
static ScrDynHandleTag ws_class_tag(double kind) {
  static const ScrDynHandleTag tags[] = {
      SCR_DYNH_WS_READABLE, SCR_DYNH_WS_READER, SCR_DYNH_WS_RCONTROLLER, SCR_DYNH_WS_COUNT_STRATEGY,
      SCR_DYNH_WS_BYTE_STRATEGY,
  };
  int index = (int)kind;
  if (index < 0 || index >= (int)(sizeof tags / sizeof tags[0])) scr_trap("scriptc: unknown web stream class\n");
  return tags[index];
}

/* The web stream class `kind` names as a constructor value (+1): the
 * compiler's webstream.class. */
ScrDyn *scr_webstream_class(double kind) {
  ws_install();
  return scr_dyn_handle_class_value(ws_class_tag(kind));
}

/* `value instanceof <class>` (webstream.instanceOf): a handle of the class,
 * or an object with the class's prototype on its chain. */
bool scr_webstream_instanceof(ScrDyn *value, double kind) {
  ws_install();
  ScrDynHandleTag tag = ws_class_tag(kind);
  if (value->kind == SCR_DYN_HANDLE) return scr_dyn_handle_class_tag_of(value) == tag;
  if (value->kind != SCR_DYN_OBJ && value->kind != SCR_DYN_ARR && value->kind != SCR_DYN_FUNC) return false;
  ScrDyn *prototype = scr_dyn_handle_class_prototype(tag);
  bool found = false;
  ScrDyn *current = scr_dyn_get_prototype(value);
  while (current && current->kind != SCR_DYN_NULL && current->kind == SCR_DYN_OBJ) {
    if (current == prototype) {
      found = true;
      break;
    }
    ScrDyn *next = scr_dyn_get_prototype(current);
    scr_dyn_release(current);
    current = next;
  }
  if (current) scr_dyn_release(current);
  if (scr_exc_pending()) scr_exc_clear();
  scr_dyn_release(prototype);
  return found;
}

/* AsyncDisposableStack: the DisposableStack storage (scr_disposable.h)
 * behind its own handle, with disposeAsync in place of dispose.
 * disposeAsync runs the entries in reverse order and awaits each result as
 * an async function would: the next entry runs one microtask turn after
 * the result settles, a callback that throws is not awaited, and an absent
 * entry (use() of null or undefined) costs one await at the end when no
 * other entry was awaited. Failures chain into a SuppressedError as in
 * DisposableStack, and the returned promise settles after the last entry.
 * Linked with scr_symbol.c and scr_async_dyn.c, whose functions it calls. */
#include "scr_runtime.h"
#include "scr_disposable.h"

#include <stdlib.h>
#include <string.h>

typedef struct {
  ScrDisposableStack *storage; /* the entries, moved out of the stack */
  size_t next;                 /* entries [0, next) are still to run */
  ScrCaught *error;            /* the disposal error so far, or NULL */
  bool needs_await, has_awaited;
  ScrPromise *result;  /* the promise disposeAsync returned */
  ScrPromise *awaited; /* the result being awaited */
} ScrAdsRun;

static void scr_ads_step(ScrAdsRun *run);

static void scr_ads_fail(ScrAdsRun *run) {
  if (run->error) scr_exc_suppress(run->error);
  run->error = scr_exc_take();
}

static void scr_ads_resume(ScrFiber *self, void *opaque) {
  (void)self;
  ScrAdsRun *run = opaque;
  run->has_awaited = true;
  ScrDyn *value = scr_await_dyn(run->awaited);
  scr_promise_release(run->awaited);
  run->awaited = NULL;
  if (value) scr_dyn_release(value);
  else scr_ads_fail(run);
  scr_ads_step(run);
}

/* Await `value` (moved in): a promise is awaited itself, any other value
 * through a fulfilled promise, as `await` takes one turn for either. */
static void scr_ads_await(ScrAdsRun *run, ScrDyn *value) {
  ScrPromise *p;
  if (value->kind == SCR_DYN_PROMISE) {
    p = scr_promise_retain(value->v.promise);
  } else {
    p = scr_promise_new();
    scr_promise_fulfill_ref(p, scr_dyn_retain(value), scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
  }
  scr_dyn_release(value);
  scr_promise_mark_handled(p);
  run->awaited = p;
  ScrPromise *waiter = scr_async_spawn_after(p, scr_ads_resume, run);
  scr_promise_release(waiter);
}

static void scr_ads_finish(ScrAdsRun *run) {
  if (run->error) {
    scr_rethrow(run->error);
    scr_caught_release(run->error);
    scr_promise_reject_pending(run->result);
  } else {
    scr_promise_resolve_dyn(run->result, scr_dyn_retain(scr_dyn_undefined()));
  }
  scr_promise_release(run->result);
  scr_ds_release(run->storage);
  free(run);
}

static void scr_ads_step(ScrAdsRun *run) {
  while (run->next > 0) {
    ScrDisposableResource *r = &run->storage->items[--run->next];
    if (r->kind == SCR_DS_ABSENT) {
      run->needs_await = true;
      continue;
    }
    ScrDyn *result;
    if (r->kind == SCR_DS_USE) {
      result = scr_dyn_using_dispose(r->method, r->value);
    } else {
      scr_dyn_this_push_dyn(scr_dyn_undefined());
      result = r->kind == SCR_DS_ADOPT ? scr_dyn_call(r->method, &r->value, 1, "onDisposeAsync")
                                       : scr_dyn_call(r->method, NULL, 0, "onDisposeAsync");
      scr_dyn_this_pop();
    }
    scr_dyn_release(r->value);
    scr_dyn_release(r->method);
    r->value = r->method = NULL;
    r->kind = SCR_DS_ABSENT;
    if (!result) {
      scr_ads_fail(run);
      continue;
    }
    scr_ads_await(run, result);
    return;
  }
  if (run->needs_await && !run->has_awaited) {
    run->needs_await = false;
    scr_ads_await(run, scr_dyn_retain(scr_dyn_undefined()));
    return;
  }
  scr_ads_finish(run);
}

static ScrDyn *scr_ads_dispose_async(const ScrDyn *self) {
  ScrPromise *p = scr_promise_new();
  ScrDyn *boxed = scr_dyn_new_promise(p);
  ScrDisposableStack *s = self->kind == SCR_DYN_HANDLE && self->v.handle.tag == SCR_DYNH_ASYNC_DISPOSABLE_STACK
    ? self->v.handle.ptr : NULL;
  if (!s) {
    /* An invalid receiver rejects the promise instead of throwing. */
    static const char message[] = "Receiver is not an AsyncDisposableStack";
    scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
    scr_promise_reject_pending(p);
  } else if (s->disposed) {
    scr_promise_resolve_dyn(p, scr_dyn_retain(scr_dyn_undefined()));
  } else {
    ScrAdsRun *run = calloc(1, sizeof *run);
    if (!run) scr_trap("scriptc: out of memory\n");
    run->storage = scr_ds_storage_new();
    scr_ds_move(run->storage, s);
    run->next = run->storage->len;
    run->result = scr_promise_retain(p);
    scr_ads_step(run);
  }
  scr_promise_release(p);
  return boxed;
}

static SCR_TL ScrDyn *scr_ads_method_values[6];
static const char *const scr_ads_method_names[] = {"use", "adopt", "defer", "move", "disposeAsync", "disposed"};
static const uint32_t scr_ads_method_lengths[] = {1, 2, 1, 0, 0, 0};
enum { SCR_ADS_M_USE, SCR_ADS_M_ADOPT, SCR_ADS_M_DEFER, SCR_ADS_M_MOVE, SCR_ADS_M_DISPOSE, SCR_ADS_M_DISPOSED };

static ScrDisposableStack *scr_ads_alloc(void);
static ScrDyn *scr_ads_box(ScrDisposableStack *s);

static ScrDyn *scr_ads_method_call(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  unsigned index = (unsigned)scr_box_get_f64(clo->caps[0]);
  ScrDyn *self = scr_dyn_this_get();
  const ScrDyn *arg0 = argc > 0 ? args[0] : scr_dyn_undefined();
  const ScrDyn *arg1 = argc > 1 ? args[1] : scr_dyn_undefined();
  const ScrDynHandleTag tag = SCR_DYNH_ASYNC_DISPOSABLE_STACK;
  ScrDyn *out = NULL;
  ScrDisposableStack *s;
  switch (index) {
  case SCR_ADS_M_USE:
    if (!(s = scr_ds_receiver(self, tag, "use", false, true))) break;
    if (arg0->kind == SCR_DYN_NULL || arg0->kind == SCR_DYN_UNDEF) {
      scr_ds_push(s, NULL, NULL, SCR_DS_ABSENT);
    } else {
      ScrDyn *method = scr_dyn_using_method(arg0, true);
      if (!method) break;
      scr_ds_push(s, scr_dyn_retain((ScrDyn *)arg0), method, SCR_DS_USE);
    }
    out = scr_dyn_retain((ScrDyn *)arg0);
    break;
  case SCR_ADS_M_ADOPT:
    if (!(s = scr_ds_receiver(self, tag, "adopt", false, true)) || !scr_ds_callable(arg1)) break;
    scr_ds_push(s, scr_dyn_retain((ScrDyn *)arg0), scr_dyn_retain((ScrDyn *)arg1), SCR_DS_ADOPT);
    out = scr_dyn_retain((ScrDyn *)arg0);
    break;
  case SCR_ADS_M_DEFER:
    if (!(s = scr_ds_receiver(self, tag, "defer", false, true)) || !scr_ds_callable(arg0)) break;
    scr_ds_push(s, NULL, scr_dyn_retain((ScrDyn *)arg0), SCR_DS_DEFER);
    out = scr_dyn_retain(scr_dyn_undefined());
    break;
  case SCR_ADS_M_MOVE: {
    if (!(s = scr_ds_receiver(self, tag, "move", false, true))) break;
    ScrDisposableStack *moved = scr_ads_alloc();
    scr_ds_move(moved, s);
    out = scr_ads_box(moved);
    scr_ds_release(moved);
    break;
  }
  default:
    out = scr_ads_dispose_async(self);
    break;
  }
  scr_dyn_release(self);
  return out;
}

static ScrDyn *scr_ads_method_value(unsigned index) {
  if (!scr_ads_method_values[index]) {
    ScrClosure *clo = scr_closure_new(NULL, 1);
    clo->caps[0] = scr_box_new(SCR_BOX_F64);
    scr_box_set_f64(clo->caps[0], (double)index);
    scr_ads_method_values[index] = scr_dyn_new_func(clo, scr_ads_method_call, scr_ads_method_lengths[index],
                                                    "", scr_ads_method_names[index]);
  }
  return scr_dyn_retain(scr_ads_method_values[index]);
}

static ScrDyn *scr_ads_get(void *ptr, const char *key, size_t len) {
  ScrDisposableStack *s = ptr;
  if (len == 8 && memcmp(key, "disposed", 8) == 0) return scr_dyn_new_bool(s->disposed);
  for (unsigned i = 0; i < SCR_ADS_M_DISPOSED; i++) {
    if (strlen(scr_ads_method_names[i]) == len && memcmp(key, scr_ads_method_names[i], len) == 0)
      return scr_ads_method_value(i);
  }
  return NULL;
}

static bool scr_ads_set(void *ptr, const char *key, size_t len, const ScrDyn *value) {
  (void)ptr;
  (void)key;
  (void)len;
  (void)value;
  return false;
}

/* [Symbol.asyncDispose] is disposeAsync itself, as in Node. */
static ScrDyn *scr_ads_symbol_get(void *ptr, const ScrDyn *key) {
  (void)ptr;
  if (key->kind != SCR_DYN_SYMBOL) return NULL;
  ScrStr *name = scr_str_new("asyncDispose", 12);
  ScrSym *async_dispose = scr_sym_well_known(name);
  scr_str_release(name);
  bool match = key->v.symbol.value == async_dispose;
  scr_sym_release(async_dispose);
  return match ? scr_ads_method_value(SCR_ADS_M_DISPOSE) : NULL;
}

static ScrDyn *scr_ads_inspect_view(void *ptr) {
  (void)ptr;
  return scr_dyn_new_obj();
}

static void scr_ads_teardown(void) {
  for (size_t i = 0; i < sizeof scr_ads_method_values / sizeof scr_ads_method_values[0]; i++) {
    scr_dyn_release(scr_ads_method_values[i]);
    scr_ads_method_values[i] = NULL;
  }
}

static const ScrDynHandleOps scr_ads_ops = {
    .cls = "AsyncDisposableStack",
    .retain = scr_ds_retain,
    .release = scr_ds_release,
    .get = scr_ads_get,
    .set = scr_ads_set,
    .inspect_view = scr_ads_inspect_view,
    .json_empty_object = true,
    .inspect_view_empty = true,
    .symbol_get = scr_ads_symbol_get,
};

static ScrDisposableStack *scr_ads_alloc(void) {
  static SCR_TL bool installed;
  if (!installed) {
    installed = true;
    scr_dyn_handle_install(SCR_DYNH_ASYNC_DISPOSABLE_STACK, &scr_ads_ops);
    scr_atexit(scr_ads_teardown);
  }
  return scr_ds_storage_new();
}

static ScrDyn *scr_ads_box(ScrDisposableStack *s) {
  return scr_dyn_new_handle(s, SCR_DYNH_ASYNC_DISPOSABLE_STACK);
}

ScrDyn *scr_async_disposable_stack_new(void) {
  ScrDisposableStack *s = scr_ads_alloc();
  ScrDyn *out = scr_ads_box(s);
  scr_ds_release(s);
  return out;
}

bool scr_async_disposable_stack_is(const ScrDyn *value) {
  return value->kind == SCR_DYN_HANDLE && value->v.handle.tag == SCR_DYNH_ASYNC_DISPOSABLE_STACK;
}

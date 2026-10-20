/* util.promisify over an untyped function. The wrapper is a native dyn
 * function: each call creates a promise, calls the original with the
 * call's receiver and arguments plus an error-first callback, and answers
 * the promise. Typed functions keep the compiler's static wrapper; this
 * unit links only into programs that promisify an `any` value. All
 * arguments are borrowed. */
#include "scr_runtime.h"

#include <stdlib.h>

static ScrBox *up_box(ScrDyn *value /* moves in */) {
  ScrBox *box = scr_box_new_obj(scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
  scr_box_set_ref(box, value);
  return box;
}

static ScrDyn *up_cap(ScrClosure *closure, size_t index) {
  return scr_box_get_ref(closure->caps[index]); /* +1 */
}

/* ── util.promisify over an untyped function ────────────────────────────
 * The wrapper calls original with the call's receiver and arguments plus a
 * callback, and answers a promise the callback settles: a truthy first
 * argument rejects with it, otherwise the second argument fulfills. A
 * synchronous throw rejects, as Node's executor does. The first settlement
 * wins. util.promisify.custom functions are not consulted. */
static ScrDyn *up_callback(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  ScrDyn *settles = up_cap(closure, 0);
  ScrPromise *promise = scr_dyn_promise_of(settles);
  if (promise && scr_promise_is_pending(promise)) {
    ScrDyn *err = argc ? args[0] : scr_dyn_undefined();
    if (scr_dyn_truthy(err)) {
      scr_dyn_throw(scr_dyn_retain(err));
      scr_promise_reject_pending(promise);
    } else {
      scr_promise_resolve_dyn(promise, scr_dyn_retain(argc > 1 ? args[1] : scr_dyn_undefined()));
    }
  }
  scr_dyn_release(settles);
  return scr_dyn_retain(scr_dyn_undefined());
}

static ScrDyn *up_call(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  ScrDyn *original = up_cap(closure, 0);
  ScrDyn *receiver = scr_dyn_this_get();
  ScrPromise *promise = scr_promise_new();
  ScrDyn *result = scr_dyn_new_promise(promise);
  ScrClosure *settle = scr_closure_new(NULL, 1);
  settle->caps[0] = up_box(scr_dyn_retain(result));
  ScrDyn *callback = scr_dyn_new_func(settle, up_callback, 2, "native:util.promisify", "");
  ScrDyn **full = malloc((argc + 1) * sizeof *full);
  if (!full) scr_trap("out of memory");
  for (size_t i = 0; i < argc; i++) full[i] = args[i];
  full[argc] = callback;
  scr_dyn_this_push_dyn(receiver);
  ScrDyn *returned = scr_dyn_call(original, full, argc + 1, "function");
  scr_dyn_this_pop();
  free(full);
  if (returned) scr_dyn_release(returned);
  else if (scr_promise_is_pending(promise)) scr_promise_reject_pending(promise);
  else scr_exc_clear();
  scr_dyn_release(callback);
  scr_dyn_release(receiver);
  scr_dyn_release(original);
  scr_promise_release(promise);
  return result;
}

ScrDyn *scr_util_promisify(ScrDyn *original) {
  if (!scr_dyn_is_callable(original)) {
    scr_dyn_arg_type_fail("original", "of type function", original);
    return NULL;
  }
  ScrClosure *closure = scr_closure_new(NULL, 1);
  closure->caps[0] = up_box(scr_dyn_retain(original));
  return scr_dyn_new_func(closure, up_call, 0, "native:util.promisify", "");
}

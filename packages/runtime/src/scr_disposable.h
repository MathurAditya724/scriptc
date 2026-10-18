#ifndef SCR_DISPOSABLE_H
#define SCR_DISPOSABLE_H

/* Storage shared by the DisposableStack handle (scr_symbol.c) and the
 * AsyncDisposableStack handle (scr_async_disposable.c). A stack is a
 * collector-headered object behind a traced dyn handle: its resources hold
 * callbacks that can capture the stack itself. Each entry records how
 * disposal calls it: `use` calls the value's dispose method with the value
 * as `this`, `adopt` calls the callback with the value, `defer` calls the
 * callback with no arguments, and an absent entry (an AsyncDisposableStack
 * use() of null or undefined) calls nothing. */

#include "scr_runtime.h"

enum { SCR_DS_USE, SCR_DS_ADOPT, SCR_DS_DEFER, SCR_DS_ABSENT };

typedef struct {
  ScrDyn *value; /* the resource (use, adopt); NULL for defer and absent */
  ScrDyn *method; /* NULL for absent */
  unsigned kind;
  /* Which members the last trace visited: the collector frees those
   * itself, and gcfree must not read them afterwards. */
  bool value_traced, method_traced;
} ScrDisposableResource;

typedef struct {
  size_t rc;
  bool disposed;
  ScrDisposableResource *items;
  size_t len, cap;
} ScrDisposableStack;

/* A new, empty stack (+1). */
ScrDisposableStack *scr_ds_storage_new(void);
void *scr_ds_retain(void *stack);
void scr_ds_release(void *stack);
/* Moves value and method in. */
void scr_ds_push(ScrDisposableStack *s, ScrDyn *value, ScrDyn *method, unsigned kind);
/* Moves `from`'s entries to `to` and marks `from` disposed. */
void scr_ds_move(ScrDisposableStack *to, ScrDisposableStack *from);
/* V8's rendering of a value in a TypeError. */
void scr_ds_put_value(ScrJsonBuf *b, const ScrDyn *value);
/* Whether `value` is callable; false with V8's TypeError pending. */
bool scr_ds_callable(const ScrDyn *value);
/* The stack behind `self` when it has handle tag `tag`, or NULL with
 * Node's TypeError (an incompatible receiver of <class>.prototype.<name>)
 * or ReferenceError (a disposed stack, when `live` is required) pending. */
ScrDisposableStack *scr_ds_receiver(const ScrDyn *self, ScrDynHandleTag tag, const char *name, bool getter,
                                    bool live);

#endif

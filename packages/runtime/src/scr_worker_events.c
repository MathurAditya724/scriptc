#include "scr_worker.h"

#ifdef SCR_WORKERS
#include <stdlib.h>

extern int sc_worker_entry(uint32_t root);

typedef struct ScrWorkerView {
  size_t rc;
  ScrEmitter *events;
  ScrWorkerThread *thread;
  ScrPromise *termination;
  bool port;
  bool closed;
  bool referenced;
  bool started;
  bool closing;
  ScrMailEvent *queued_head;
  ScrMailEvent *queued_tail;
  /* A MessageChannel port: its channel (+1) and end; NULL for parentPort. */
  ScrChannel *channel;
  int side;
  bool detached; /* transferred to another thread */
  uint64_t close_seq; /* when close() ran: the latest close emits first */
  uint64_t close_gen; /* the poll generation close() ran in */
  size_t phase_left; /* messages this poll phase still delivers */
  bool phase_close;  /* the other end's close, delivered this phase */
  struct ScrWorkerView *next;
} ScrWorkerView;

static SCR_TL ScrMailbox *scr_worker_events;
static SCR_TL ScrWorkerView *scr_worker_views;
static SCR_TL ScrWorkerView *scr_worker_port;
/* this thread's MessageChannel ports (registry references) */
static SCR_TL ScrWorkerView *scr_channel_ports;
static SCR_TL uint64_t scr_channel_close_seq;
static SCR_TL bool scr_channel_phase; /* a poll phase is being delivered */
/* completed poll phases: a port's 'close' runs in the close phase after
 * the poll phase its close() came before or during */
static SCR_TL uint64_t scr_channel_poll_gen;
/* the loop pass continues a phase (scr_channel_more answered true) */
static SCR_TL bool scr_channel_continuing;
static SCR_TL bool scr_channel_closing_phase;
static const char *const scr_worker_method_names[] = {
  "ref", "unref", "hasRef", "terminate", "postMessage", "on", "once", "addListener",
  "prependListener", "prependOnceListener", "off", "removeListener", "removeAllListeners",
  "listenerCount", "close", "start",
};
static SCR_TL ScrDyn *scr_worker_methods[sizeof scr_worker_method_names / sizeof scr_worker_method_names[0]];

static void scr_worker_view_trace(void *ptr, ScrTraceVisit visit, void *ctx) {
  visit(((ScrWorkerView *)ptr)->events, ctx);
  visit(((ScrWorkerView *)ptr)->termination, ctx);
}

static void scr_worker_view_gcfree(void *ptr) {
  ScrWorkerView *view = ptr;
  scr_worker_thread_release(view->thread);
  scr_channel_release(view->channel);
  while (view->queued_head) {
    ScrMailEvent *event = view->queued_head;
    view->queued_head = event->next;
    scr_mail_event_free(event);
  }
  scr_obj_free_note();
  scr_cyc_free(ptr);
}

static void scr_worker_view_destroy(void *ptr) {
  ScrWorkerView *view = ptr;
  scr_emitter_release(view->events);
  scr_promise_release(view->termination);
  scr_worker_view_gcfree(ptr);
}

static void *scr_worker_view_retain(void *ptr) {
  ScrWorkerView *view = ptr;
  view->rc++;
  return view;
}

static void scr_worker_view_release(void *ptr) {
  ScrWorkerView *view = ptr;
  if (!view) return;
  if (--view->rc == 0) {
    scr_cyc_dead(view);
    scr_rc_destroy(view, scr_worker_view_destroy);
  } else scr_cyc_released(view);
}

static void scr_worker_port_listeners(void *ptr, const ScrStr *name, bool present) {
  ScrWorkerView *view = ptr;
  if (name->len != 7 || memcmp(name->data, "message", 7)) return;
  if (present) view->started = true;
  view->referenced = present;
}

static ScrWorkerView *scr_worker_view_new(bool port) {
  static ScrCycType cyc_type = { &scr_worker_view_trace, &scr_worker_view_gcfree, SCR_CYC_KIND_WORKER_VIEW };
  ScrWorkerView *view = scr_cyc_alloc(sizeof(*view), &cyc_type);
  view->rc = 1;
  view->port = port;
  view->referenced = !port;
  view->events = scr_emitter_new();
  view->events->cls = port ? "MessagePort" : "Worker";
  if (port) scr_emitter_observe(view->events, scr_worker_port_listeners, view);
  scr_obj_alloc_note();
  return view;
}

static ScrDyn *scr_worker_refusal(const char *operation) {
  ScrStr *message = scr_str_new(operation, strlen(operation));
  scr_throw_lowering_fence(message);
  scr_str_release(message);
  return NULL;
}

static bool scr_worker_empty_transfer(const ScrDyn *value) {
  if (value->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *view = scr_dyn_typed_ref_materialize(value);
    bool empty = view && !scr_exc_pending() && scr_worker_empty_transfer(view);
    scr_dyn_release(view);
    return empty;
  }
  return value->kind == SCR_DYN_UNDEF || (value->kind == SCR_DYN_ARR && value->v.arr.len == 0);
}

/* postMessage's transfer argument: an array, or { transfer } (+1, or NULL
 * when empty) */
static ScrDyn *scr_worker_transfer_list(ScrDyn *arg) {
  ScrDyn *value = arg;
  ScrDyn *own = NULL;
  if (value->kind == SCR_DYN_TYPED_REF) {
    own = scr_dyn_typed_ref_materialize(value);
    if (!own || scr_exc_pending()) {
      scr_dyn_release(own);
      return NULL;
    }
    value = own;
  }
  if (value->kind == SCR_DYN_OBJ) {
    ScrDyn *list = scr_dyn_obj_get(value, "transfer", 8);
    ScrDyn *result = list ? scr_worker_transfer_list(list) : NULL;
    scr_dyn_release(own);
    return result;
  }
  if (value->kind == SCR_DYN_ARR && value->v.arr.len > 0) {
    ScrDyn *result = scr_dyn_retain(value);
    scr_dyn_release(own);
    return result;
  }
  bool empty = scr_worker_empty_transfer(value);
  scr_dyn_release(own);
  if (!empty) scr_worker_refusal("This postMessage transfer argument is not supported yet");
  return NULL;
}

static bool scr_worker_transfer_has(const ScrDyn *transfer, const ScrWorkerView *view) {
  for (size_t i = 0; i < transfer->v.arr.len; i++) {
    const ScrDyn *item = transfer->v.arr.items[i];
    if (item && item->kind == SCR_DYN_HANDLE && item->v.handle.ptr == view) return true;
  }
  return false;
}

static ScrDyn *scr_worker_view_invoke(void *ptr, ScrDyn *self, const char *method,
                                     ScrDyn *const *args, size_t argc, const char *what) {
  (void)what;
  ScrWorkerView *view = ptr;
  if (!strcmp(method, "ref") || !strcmp(method, "unref")) {
    view->referenced = !strcmp(method, "ref");
    return scr_dyn_retain(scr_dyn_undefined());
  }
  if (view->port && !strcmp(method, "hasRef"))
    return scr_dyn_new_bool(view->referenced && (!view->closed || (view->channel && view->closing)));
  if (!view->port && !strcmp(method, "terminate")) {
    if (!view->termination) {
      view->termination = scr_promise_new();
      if (view->closed) scr_promise_fulfill_ref(view->termination,
        scr_dyn_retain(scr_dyn_undefined()), scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
      else scr_worker_thread_terminate(view->thread);
    }
    return scr_dyn_new_promise(view->termination);
  }
  if (!strcmp(method, "postMessage")) {
    /* Worker drops messages after exit before validating or cloning. A
     * closed MessagePort still validates its payload, as Node does. */
    if (!view->port && view->closed) return scr_dyn_retain(scr_dyn_undefined());
    if (view->detached) return scr_dyn_retain(scr_dyn_undefined());
    if (!argc) {
      if (view->channel) {
        static const char message[] = "Not enough arguments to MessagePort.postMessage";
        scr_throw_error_msg_code(SCR_ERR_TYPE, message, sizeof message - 1, "ERR_MISSING_ARGS");
      } else {
        static const char message[] = "The \"value\" argument must be specified";
        scr_throw_error_msg_code(SCR_ERR_TYPE, message, sizeof message - 1, "ERR_MISSING_ARGS");
      }
      return NULL;
    }
    ScrDyn *transfer = argc > 1 ? scr_worker_transfer_list(args[1]) : NULL;
    if (scr_exc_pending()) return NULL;
    if (transfer && scr_worker_transfer_has(transfer, view)) {
      scr_dyn_release(transfer);
      scr_throw_domex("DataCloneError", "Transfer list contains source port");
      return NULL;
    }
    ScrMessage *message = scr_message_encode_transfer(args[0], transfer);
    scr_dyn_release(transfer);
    if (!message) return NULL;
    if (view->closed) scr_message_free(message);
    else if (view->channel)
      scr_channel_post(view->channel, view->side, message, SCR_WORKER_MESSAGE, SCR_WORKER_WAKE);
    else if (view->port) scr_worker_post_parent(message);
    else scr_worker_thread_post(view->thread, message);
    return scr_dyn_retain(scr_dyn_undefined());
  }
  bool once = !strcmp(method, "once") || !strcmp(method, "prependOnceListener");
  bool prepend = !strcmp(method, "prependListener") || !strcmp(method, "prependOnceListener");
  if (once || prepend || !strcmp(method, "on") || !strcmp(method, "addListener")) {
    ScrDyn *listener = argc > 1 ? args[1] : scr_dyn_undefined();
    scr_dyn_check_listener(listener, "listener");
    if (scr_exc_pending()) return NULL;
    if (!argc || args[0]->kind != SCR_DYN_STR)
      return scr_worker_refusal("Worker event names must be strings");
    scr_emitter_release(scr_emitter_on_flex(view->events, args[0]->v.str, listener, once, prepend));
    return scr_exc_pending() ? NULL : scr_dyn_retain(self);
  }
  if (!strcmp(method, "off") || !strcmp(method, "removeListener")) {
    ScrDyn *listener = argc > 1 ? args[1] : scr_dyn_undefined();
    scr_dyn_check_listener(listener, "listener");
    if (scr_exc_pending()) return NULL;
    if (!argc || args[0]->kind != SCR_DYN_STR)
      return scr_worker_refusal("Worker event names must be strings");
    scr_emitter_release(scr_emitter_off_dyn(view->events, args[0]->v.str, listener));
    return scr_exc_pending() ? NULL : scr_dyn_retain(self);
  }
  if (!strcmp(method, "removeAllListeners")) {
    bool all = !argc || args[0]->kind == SCR_DYN_UNDEF;
    if (!all && args[0]->kind != SCR_DYN_STR)
      return scr_worker_refusal("Worker event names must be strings");
    scr_emitter_release(scr_emitter_remove_all(view->events, all ? NULL : args[0]->v.str, all));
    return scr_exc_pending() ? NULL : scr_dyn_retain(self);
  }
  if (!strcmp(method, "listenerCount")) {
    if (!argc || args[0]->kind != SCR_DYN_STR)
      return scr_worker_refusal("Worker event names must be strings");
    return scr_dyn_new_num(argc > 1 && args[1]->kind != SCR_DYN_UNDEF
      ? scr_emitter_listener_count_dyn(view->events, args[0]->v.str, args[1])
      : scr_emitter_listener_count(view->events, args[0]->v.str));
  }
  if (view->port && !strcmp(method, "close")) {
    if (argc && args[0]->kind != SCR_DYN_UNDEF) {
      scr_dyn_check_listener(args[0], "callback");
      if (scr_exc_pending()) return NULL;
      ScrStr *name = scr_str_new("close", 5);
      scr_emitter_release(scr_emitter_on_flex(view->events, name, args[0], true, false));
      scr_str_release(name);
    }
    if (!view->closed && !view->detached) {
      view->closing = true;
      view->closed = true;
      if (view->channel) {
        view->close_seq = ++scr_channel_close_seq;
        view->close_gen = scr_channel_poll_gen;
        scr_channel_close(view->channel, view->side);
      } else {
        scr_worker_port_close();
      }
    }
    return scr_dyn_retain(scr_dyn_undefined());
  }
  if (view->port && !strcmp(method, "start")) {
    view->started = true;
    return scr_dyn_retain(scr_dyn_undefined());
  }
  return scr_worker_refusal("This Worker or MessagePort method is not supported yet");
}

static ScrDyn *scr_worker_method_call(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  ScrDyn *self = scr_dyn_this_get();
  ScrDyn *result = NULL;
  if (self->kind != SCR_DYN_HANDLE ||
      (self->v.handle.tag != SCR_DYNH_WORKER && self->v.handle.tag != SCR_DYNH_MESSAGE_PORT)) {
    static const char message[] = "Illegal invocation";
    scr_throw_error_msg_code(SCR_ERR_TYPE, message, sizeof message - 1, "ERR_INVALID_THIS");
  } else {
    size_t method = (size_t)scr_box_get_f64(closure->caps[0]);
    result = scr_worker_view_invoke(self->v.handle.ptr, self, scr_worker_method_names[method], args, argc, "worker method");
  }
  scr_dyn_release(self);
  return result;
}

static ScrDyn *scr_worker_view_get(void *ptr, const char *key, size_t length) {
  ScrWorkerView *view = ptr;
  if (!view->port && length == 8 && !memcmp(key, "threadId", 8))
    return scr_dyn_new_num(view->closed ? -1 : (double)scr_worker_thread_id(view->thread));
  for (size_t i = 0; i < sizeof scr_worker_methods / sizeof scr_worker_methods[0]; i++) {
    const char *name = scr_worker_method_names[i];
    if (strlen(name) != length || memcmp(name, key, length)) continue;
    if ((view->port && !strcmp(name, "terminate")) ||
        (!view->port && (!strcmp(name, "start") || !strcmp(name, "close") || !strcmp(name, "hasRef")))) return NULL;
    if (!scr_worker_methods[i]) {
      ScrClosure *closure = scr_closure_new(NULL, 1);
      closure->caps[0] = scr_box_new(SCR_BOX_F64);
      scr_box_set_f64(closure->caps[0], (double)i);
      scr_worker_methods[i] = scr_dyn_new_func(closure, scr_worker_method_call, 0, "", name);
    }
    return scr_dyn_retain(scr_worker_methods[i]);
  }
  return NULL;
}

static bool scr_workers_pending(void) {
  for (ScrWorkerView *view = scr_worker_views; view; view = view->next)
    if (view->referenced) return true;
  for (ScrWorkerView *view = scr_channel_ports; view; view = view->next)
    if (view->closing || (view->started && view->referenced && !view->closed && !view->detached))
      return true;
  return scr_worker_port && (scr_worker_port->closing ||
    (scr_worker_port->referenced && !scr_worker_port->closed));
}

static int scr_worker_events_pollfd(void) {
  return scr_worker_events ? scr_mailbox_pollfd(scr_worker_events) : -1;
}

/* a channel port with something to deliver: its 'close', the other end's
 * close, or messages once started */
static bool scr_channel_port_ready(ScrWorkerView *view) {
  if (view->closing || view->phase_left || view->phase_close) return true;
  if (view->closed || view->detached) return false;
  if (view->started && scr_channel_count(view->channel, view->side) > 0) return true;
  return scr_channel_peer_closed(view->channel, view->side) &&
         scr_channel_count(view->channel, view->side) == 0;
}

static bool scr_worker_events_ready(void) {
  for (ScrWorkerView *view = scr_channel_ports; view; view = view->next)
    if (scr_channel_port_ready(view)) return true;
  return (scr_worker_port && (scr_worker_port->closing ||
    (scr_worker_port->started && scr_worker_port->queued_head))) ||
    (scr_worker_events && scr_mailbox_pending(scr_worker_events));
}

static void scr_worker_events_wait(double milliseconds) {
  if (!scr_worker_events_ready()) scr_mailbox_wait(scr_worker_events, milliseconds);
}

static void scr_worker_port_emit(ScrWorkerView *view, const char *event, ScrDyn *argument) {
  ScrStr *name = scr_str_new(event, strlen(event));
  scr_dyn_this_push(view, SCR_DYNH_MESSAGE_PORT);
  scr_emitter_emit_flex(view->events, name, argument ? &argument : NULL, argument ? 1 : 0);
  scr_dyn_this_pop();
  scr_str_release(name);
}

/* The channel ports' turn, one event per call, in Node's phase order:
 * - the close phase: ports this thread closed, the latest close() first
 *   (libuv's close callbacks), each telling its other end;
 * - the poll phase: a snapshot of each port's queued messages (the batch
 *   Node delivers), ports in creation order, then the other ends' close
 *   notices in the order they were sent. scr_channel_more keeps the loop
 *   pass going until the phase is delivered, with microtasks between.
 * False when nothing was ready. */
static bool scr_channel_close_due(const ScrWorkerView *view) {
  return view->closing && view->close_gen < scr_channel_poll_gen;
}

static bool scr_channel_dispatch(void) {
  bool continuing = scr_channel_continuing;
  scr_channel_continuing = false;
  /* a loop pass runs one phase: the close phase, or the poll phase */
  if (scr_channel_closing_phase && !continuing) scr_channel_closing_phase = false;
  if (!scr_channel_phase && (!continuing || scr_channel_closing_phase)) {
    ScrWorkerView *latest = NULL;
    for (ScrWorkerView *view = scr_channel_ports; view; view = view->next)
      if (scr_channel_close_due(view) && (!latest || view->close_seq > latest->close_seq))
        latest = view;
    if (latest) {
      scr_worker_view_retain(latest);
      latest->closing = false;
      scr_channel_closing_phase = true;
      scr_channel_drop(latest->channel, latest->side);
      scr_channel_notify_close(latest->channel, latest->side, SCR_WORKER_WAKE);
      scr_worker_port_emit(latest, "close", NULL);
      scr_worker_view_release(latest);
      return true;
    }
    if (scr_channel_closing_phase) return false;
    bool any = false;
    for (ScrWorkerView *view = scr_channel_ports; view; view = view->next) {
      if (view->closed || view->detached) continue;
      size_t count = scr_channel_count(view->channel, view->side);
      view->phase_left = view->started ? count : 0;
      view->phase_close = count == 0 && scr_channel_peer_closed(view->channel, view->side) != 0;
      any = any || view->phase_left || view->phase_close;
    }
    if (!any) {
      scr_channel_poll_gen++;
      return false;
    }
    scr_channel_phase = true;
  }
  for (ScrWorkerView *view = scr_channel_ports; view; view = view->next) {
    if (!view->phase_left) continue;
    view->phase_left--;
    ScrMailEvent *event = scr_channel_take(view->channel, view->side);
    if (!event) {
      view->phase_left = 0;
      continue;
    }
    scr_worker_view_retain(view);
    ScrDyn *argument = event->message ? scr_message_decode(event->message) : NULL;
    if (argument) scr_worker_port_emit(view, "message", argument);
    scr_dyn_release(argument);
    scr_mail_event_free(event);
    scr_worker_view_release(view);
    return true;
  }
  ScrWorkerView *first = NULL;
  uint64_t first_seq = 0;
  for (ScrWorkerView *view = scr_channel_ports; view; view = view->next) {
    if (!view->phase_close) continue;
    uint64_t seq = scr_channel_peer_closed(view->channel, view->side);
    if (!first || seq < first_seq) {
      first = view;
      first_seq = seq;
    }
  }
  if (!first) {
    scr_channel_phase = false;
    scr_channel_poll_gen++;
    return false;
  }
  first->phase_close = false;
  if (first->closed) return true;
  scr_worker_view_retain(first);
  first->closed = true;
  scr_channel_drop(first->channel, first->side);
  scr_worker_port_emit(first, "close", NULL);
  scr_worker_view_release(first);
  return true;
}

/* more of the current poll phase to deliver in this loop pass */
static bool scr_channel_more(void) {
  bool more = false;
  if (scr_channel_closing_phase) {
    /* the close phase runs its callbacks back to back */
    for (ScrWorkerView *view = scr_channel_ports; view; view = view->next)
      if (scr_channel_close_due(view)) more = true;
  } else if (scr_channel_phase) {
    for (ScrWorkerView *view = scr_channel_ports; view; view = view->next)
      if (view->phase_left || view->phase_close) more = true;
    if (!more) {
      scr_channel_phase = false;
      scr_channel_poll_gen++;
    }
  }
  scr_channel_continuing = more;
  return more;
}

static void scr_worker_dispatch(void) {
  if (scr_channel_dispatch()) return;
  ScrWorkerView *port = scr_worker_port;
  if (port && port->closing) {
    port->closing = false;
    ScrStr *name = scr_str_new("close", 5);
    scr_dyn_this_push(port, SCR_DYNH_MESSAGE_PORT);
    scr_emitter_emit_flex(port->events, name, NULL, 0);
    scr_dyn_this_pop();
    scr_str_release(name);
    if (scr_exc_pending()) return;
  }
  ScrMailEvent *event;
  if (port && port->started && port->queued_head) {
    event = port->queued_head;
    port->queued_head = event->next;
    if (!port->queued_head) port->queued_tail = NULL;
    event->next = NULL;
  } else event = scr_mailbox_take(scr_worker_events);
  if (!event) return;
  if (event->kind == SCR_WORKER_WAKE) { scr_mail_event_free(event); return; }
  ScrWorkerView *view = scr_worker_port;
  if (event->source) {
    view = scr_worker_views;
    while (view && scr_worker_thread_id(view->thread) != event->source) view = view->next;
  }
  if (!view) { scr_mail_event_free(event); return; }
  if (view->port && event->kind == SCR_WORKER_MESSAGE) {
    if (view->closed) { scr_mail_event_free(event); return; }
    if (!view->started) {
      if (view->queued_tail) view->queued_tail->next = event;
      else view->queued_head = event;
      view->queued_tail = event;
      return;
    }
  }
  scr_worker_view_retain(view);
  const char *event_name = event->kind == SCR_WORKER_ONLINE ? "online" :
    event->kind == SCR_WORKER_EXIT ? "exit" : event->kind == SCR_WORKER_ERROR ? "error" : "message";
  ScrDyn *argument = event->message ? scr_message_decode(event->message) :
    event->kind == SCR_WORKER_EXIT ? scr_dyn_new_num(event->code) : NULL;
  if (event->kind == SCR_WORKER_EXIT) {
    scr_worker_thread_join(view->thread);
    view->closed = true;
    if (view->termination) scr_promise_fulfill_ref(view->termination,
      scr_dyn_new_num(event->code), scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
    ScrWorkerView **slot = &scr_worker_views;
    while (*slot != view) slot = &(*slot)->next;
    *slot = view->next;
    view->next = NULL;
    scr_worker_view_release(view); /* registry reference */
  }
  if (!scr_exc_pending()) {
    ScrStr *name = scr_str_new(event_name, strlen(event_name));
    scr_dyn_this_push(view, view->port ? SCR_DYNH_MESSAGE_PORT : SCR_DYNH_WORKER);
    if (event->kind == SCR_WORKER_ERROR) scr_emitter_emit_error_flex(view->events, argument);
    else scr_emitter_emit_flex(view->events, name, argument ? &argument : NULL, argument ? 1 : 0);
    scr_dyn_this_pop();
    scr_str_release(name);
  }
  scr_dyn_release(argument);
  scr_worker_view_release(view);
  scr_mail_event_free(event);
}

static void scr_worker_events_cleanup(void) {
  scr_loop_set_workers(NULL, NULL, NULL, NULL, NULL);
  scr_loop_set_workers_more(NULL);
  scr_mailbox_close(scr_worker_events);
  for (ScrWorkerView *view = scr_worker_views; view; view = view->next)
    scr_worker_thread_terminate(view->thread);
  while (scr_worker_views) {
    ScrWorkerView *view = scr_worker_views;
    scr_worker_views = view->next;
    view->next = NULL;
    scr_worker_thread_join(view->thread);
    scr_worker_view_release(view);
  }
  scr_worker_view_release(scr_worker_port);
  scr_worker_port = NULL;
  while (scr_channel_ports) {
    ScrWorkerView *view = scr_channel_ports;
    scr_channel_ports = view->next;
    view->next = NULL;
    if (view->channel) scr_channel_set_owner(view->channel, view->side, NULL, SCR_WORKER_WAKE);
    scr_worker_view_release(view);
  }
  for (size_t i = 0; i < sizeof scr_worker_methods / sizeof scr_worker_methods[0]; i++) {
    scr_dyn_release(scr_worker_methods[i]);
    scr_worker_methods[i] = NULL;
  }
  scr_mailbox_release(scr_worker_events);
  scr_worker_events = NULL;
}

static void scr_port_ops_install(void);

static bool scr_worker_events_install(void) {
  if (scr_worker_events) return true;
  ScrMailbox *inbox = scr_worker_inbox();
  scr_worker_events = inbox ? scr_mailbox_retain(inbox) : scr_mailbox_new();
  if (!scr_worker_events) return false;
  if (inbox && !scr_worker_port) scr_worker_port = scr_worker_view_new(true);
  static const ScrDynHandleOps worker_ops = {
    .cls = "Worker", .retain = scr_worker_view_retain, .release = scr_worker_view_release,
    .invoke = scr_worker_view_invoke, .get = scr_worker_view_get,
  };
  static const ScrDynHandleOps port_ops = {
    .cls = "MessagePort", .retain = scr_worker_view_retain, .release = scr_worker_view_release,
    .invoke = scr_worker_view_invoke, .get = scr_worker_view_get,
  };
  scr_dyn_handle_install(SCR_DYNH_WORKER, &worker_ops);
  scr_dyn_handle_install(SCR_DYNH_MESSAGE_PORT, &port_ops);
  scr_port_ops_install();
  if (scr_context_atexit(scr_worker_events_cleanup) != 0) scr_trap("scriptc: out of memory\n");
  scr_loop_set_workers(scr_workers_pending, scr_worker_events_ready, scr_worker_dispatch,
    scr_worker_events_pollfd, scr_worker_events_wait);
  scr_loop_set_workers_more(scr_channel_more);
  return true;
}

/* ── MessageChannel ports ─────────────────────────────────────────────── */

static ScrWorkerView *scr_channel_port_new(ScrChannel *channel /*borrowed*/, int side) {
  ScrWorkerView *view = scr_worker_view_new(true);
  view->channel = scr_channel_retain(channel);
  view->side = side;
  /* the registry reference, in creation order (Node delivers ports in the
   * order their handles were made) */
  ScrWorkerView **tail = &scr_channel_ports;
  while (*tail) tail = &(*tail)->next;
  *tail = view;
  scr_channel_set_owner(channel, side, scr_worker_events, SCR_WORKER_WAKE);
  return view;
}

static ScrWorkerView *scr_port_view_of(const ScrDyn *value) {
  if (!value || value->kind != SCR_DYN_HANDLE || value->v.handle.tag != SCR_DYNH_MESSAGE_PORT)
    return NULL;
  return value->v.handle.ptr;
}

static ScrChannel *scr_port_channel_of(const ScrDyn *value, int *side) {
  ScrWorkerView *view = scr_port_view_of(value);
  if (!view || !view->channel || view->detached) return NULL;
  *side = view->side;
  return scr_channel_retain(view->channel);
}

static bool scr_port_is(const ScrDyn *value) { return scr_port_view_of(value) != NULL; }

/* the sender's port after a transfer: inert, and no longer this thread's */
static void scr_port_detach(const ScrDyn *value) {
  ScrWorkerView *view = scr_port_view_of(value);
  if (!view || !view->channel || view->detached) return;
  view->detached = true;
  view->closing = false;
  scr_channel_set_owner(view->channel, view->side, NULL, SCR_WORKER_WAKE);
}

static ScrDyn *scr_port_adopt(ScrChannel *channel, int side) {
  if (!scr_worker_events_install()) return NULL;
  ScrWorkerView *view = scr_channel_port_new(channel, side);
  return scr_dyn_new_handle(view, SCR_DYNH_MESSAGE_PORT);
}

static const ScrMessagePortOps scr_port_ops = {
    &scr_port_channel_of, &scr_port_is, &scr_port_detach, &scr_port_adopt, &scr_channel_release,
};

static void scr_port_ops_install(void) { scr_message_port_ops = &scr_port_ops; }

/* new MessageChannel(): { port1, port2 } */
ScrDyn *scr_worker_message_channel(void) {
  if (!scr_worker_events_install()) return NULL;
  ScrChannel *channel = scr_channel_new();
  ScrWorkerView *a = scr_channel_port_new(channel, 0);
  ScrWorkerView *b = scr_channel_port_new(channel, 1);
  scr_channel_release(channel);
  ScrDyn *object = scr_dyn_new_obj();
  scr_dyn_obj_set(object, "port1", 5, scr_dyn_new_handle(a, SCR_DYNH_MESSAGE_PORT));
  scr_dyn_obj_set(object, "port2", 5, scr_dyn_new_handle(b, SCR_DYNH_MESSAGE_PORT));
  return object;
}

/* receiveMessageOnPort(port): { message } of the next queued message, or
 * undefined */
ScrDyn *scr_worker_receive_message_on_port(ScrDyn *port) {
  ScrWorkerView *view = scr_port_view_of(port);
  if (!view) {
    static const char message[] = "The \"port\" argument must be a MessagePort instance";
    scr_throw_error_msg_code(SCR_ERR_TYPE, message, sizeof message - 1, "ERR_INVALID_ARG_TYPE");
    return NULL;
  }
  if (!view->channel) return scr_worker_refusal("receiveMessageOnPort on parentPort is not supported yet");
  ScrMailEvent *event = view->closed || view->detached ? NULL : scr_channel_take(view->channel, view->side);
  if (!event) return scr_dyn_retain(scr_dyn_undefined());
  ScrDyn *value = event->message ? scr_message_decode(event->message) : NULL;
  scr_mail_event_free(event);
  if (!value) return NULL;
  ScrDyn *object = scr_dyn_new_obj();
  scr_dyn_obj_set(object, "message", 7, value);
  return object;
}

ScrDyn *scr_worker_parent_port(void) {
  if (scr_context_is_main()) return scr_dyn_new_null();
  if (!scr_worker_events_install()) return NULL;
  if (!scr_worker_port) scr_worker_port = scr_worker_view_new(true);
  return scr_dyn_new_handle(scr_worker_port, SCR_DYNH_MESSAGE_PORT);
}

static ScrArr *scr_worker_arguments(ScrStr *filename, ScrDyn *argv) {
  if (argv->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *view = scr_dyn_typed_ref_materialize(argv);
    ScrArr *result = !view || scr_exc_pending() ? NULL : scr_worker_arguments(filename, view);
    scr_dyn_release(view);
    return result;
  }
  if (argv->kind != SCR_DYN_UNDEF && argv->kind != SCR_DYN_ARR) {
    scr_dyn_arg_type_fail("options.argv", "an instance of Array", argv);
    return NULL;
  }
  ScrArr *arguments = scr_arr_new(SCR_ELEM_STR, 0);
  scr_arr_push_ref(arguments, scr_str_retain(filename));
  if (argv->kind == SCR_DYN_ARR) {
    for (size_t i = 0; i < argv->v.arr.len; i++) {
      ScrDyn *value = scr_dyn_arr_at(argv, (double)i);
      ScrStr *text = scr_dyn_to_string(value, NULL);
      scr_dyn_release(value);
      if (!text || scr_exc_pending()) {
        scr_str_release(text);
        scr_arr_release(arguments);
        return NULL;
      }
      if (memchr(text->data, 0, text->len)) {
        scr_str_release(text);
        scr_arr_release(arguments);
        scr_worker_refusal("Worker argv strings containing null bytes are not supported yet");
        return NULL;
      }
      scr_arr_push_ref(arguments, text);
    }
  }
  return arguments;
}

static ScrDyn *scr_worker_new_options(double root, ScrStr *filename, ScrDyn *options) {
  if (!scr_worker_events_install()) return NULL;
  ScrDyn *data = scr_dyn_undefined();
  ScrDyn *argv = scr_dyn_undefined();
  ScrDyn *transfer_list = scr_dyn_undefined();
  if (options->kind != SCR_DYN_UNDEF) {
    if (options->kind != SCR_DYN_OBJ) {
      scr_dyn_arg_type_fail("options", "object", options);
      return NULL;
    }
    for (size_t i = 0; i < options->v.obj.len; i++) {
      const ScrDynEntry *entry = &options->v.obj.entries[i];
      if (entry->accessor) return scr_worker_refusal("Worker option accessors are not supported yet");
      if (entry->key_len == 10 && !memcmp(entry->key, "workerData", 10)) data = entry->value;
      else if (entry->key_len == 4 && !memcmp(entry->key, "argv", 4)) argv = entry->value;
      else if (entry->key_len == 12 && !memcmp(entry->key, "transferList", 12)) transfer_list = entry->value;
      else return scr_worker_refusal("This Worker constructor option is not supported yet");
    }
  }
  ScrArr *arguments = scr_worker_arguments(filename, argv);
  if (!arguments) return NULL;
  ScrDyn *transfer = scr_worker_transfer_list(transfer_list);
  if (scr_exc_pending()) { scr_arr_release(arguments); return NULL; }
  ScrMessage *wire = scr_message_encode_transfer(data, transfer);
  scr_dyn_release(transfer);
  if (!wire) { scr_arr_release(arguments); return NULL; }
  ScrWorkerThread *thread = scr_worker_thread_start(sc_worker_entry, (uint32_t)root, wire, scr_worker_events, arguments);
  scr_arr_release(arguments);
  if (!thread) return NULL;
  ScrWorkerView *view = scr_worker_view_new(false);
  view->thread = thread;
  view->next = scr_worker_views;
  scr_worker_views = view;
  return scr_dyn_new_handle(view, SCR_DYNH_WORKER);
}

ScrDyn *scr_worker_new(double root, ScrStr *filename, ScrDyn *options) {
  ScrDyn *view = options->kind == SCR_DYN_TYPED_REF ? scr_dyn_typed_ref_materialize(options) : NULL;
  ScrDyn *result = scr_exc_pending() ? NULL : scr_worker_new_options(root, filename, view ? view : options);
  scr_dyn_release(view);
  return result;
}
#endif

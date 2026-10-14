/* node:readline and node:readline/promises — the non-terminal Interface
 * (lib/internal/readline/interface.js) over process.stdin or a stream
 * input, linked only when the program uses it (the events gating;
 * rl.* libCalls imply events). The stream side (listeners on the input,
 * pause/resume, output writes) lives in scr_stream.c behind ScrRlIo, so
 * stdin-only programs never link the stream unit.
 *
 * Behavior, matching Node v24.15.0:
 * - Input bytes run through a UTF-8 decoder that holds an incomplete
 *   trailing sequence for the next chunk (StringDecoder); invalid bytes
 *   decode to U+FFFD. String chunks pass through unchanged.
 * - Lines split on /\r?\n|\r(?!\n)/: a trailing \r ends its line at once,
 *   and a \n starting the next chunk is dropped when it arrives within
 *   crlfDelay ms (default and minimum 100).
 * - Each line answers a pending question, or else is emitted as 'line'.
 *   A second question while one is pending writes the prompt again and is
 *   otherwise ignored.
 * - The input's 'end' emits a non-empty partial line as 'line' (a pending
 *   question does not receive it), then close().
 * - close() pauses (emitting 'pause' when not already paused), removes
 *   the input listeners, and emits 'close' synchronously. A pending
 *   question is never answered.
 * - Prompts are written only when an output was given.
 * - The async iterator is events.on(rl, 'line', { close: ['close'],
 *   highWaterMark: 1024 }): lines queue until next() takes them, the
 *   input pauses above 1024 queued lines and resumes once the queue
 *   empties, and return() stops listening while queued lines stay
 *   readable.
 * - On stdin, an interface created after stdin ended is DEAD: a question
 *   still writes its prompt, but nothing ever answers and 'close' never
 *   fires. */
#include "scr_runtime.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void scr_rl_oom(void) {
  fputs("scriptc: out of memory\n", stderr);
  abort();
}

static void *scr_rl_grow(void *p, size_t *cap, size_t need, size_t elem) {
  if (need <= *cap) return p;
  size_t c = *cap ? *cap * 2 : 4;
  while (c < need) c *= 2;
  void *q = realloc(p, c * elem);
  if (!q) scr_rl_oom();
  *cap = c;
  return q;
}

enum { RL_EV_LINE, RL_EV_CLOSE, RL_EV_PAUSE, RL_EV_RESUME, RL_EV_ERROR, RL_EV_COUNT };

typedef void (*ScrRlLineFn)(ScrClosure *, ScrStr *); /* owns the +1 line */
typedef void (*ScrRlErrFn)(ScrClosure *, ScrError *); /* borrows the error */

/* One listener: a user closure (fn: the line or error adapter; NULL for
 * the zero-argument events), or the async iterator's own handler. */
typedef struct {
  ScrClosure *cb;
  void *fn;
  bool once;
  bool iter;
} RlEntry;

typedef struct {
  RlEntry *v;
  size_t n, cap;
} RlList;

typedef struct {
  ScrStr **q; /* queued lines (owned) */
  size_t head, len, cap;
  ScrPromise **waiters; /* pending next() promises (owned) */
  size_t wn, wcap;
  ScrError *error; /* an 'error' no next() has seen yet (owned) */
  bool finished, paused;
} RlIter;

typedef struct ScrRl {
  double id;
  bool closed;
  bool stdin_in; /* reads process.stdin through the shared consumer */
  bool dead;     /* stdin only: created after stdin ended */
  bool paused;
  const ScrRlIo *io; /* the stream side, for a stream input or output */
  void *in;  /* the input stream (+1), or NULL */
  void *out; /* the output stream (+1), or NULL */
  bool out_stdout;
  ScrStr *prompt, *old_prompt;
  ScrClosure *q_cb; /* the pending question's callback (owned) */
  ScrRlLineFn q_fn;
  RlList ev[RL_EV_COUNT];
  /* the line splitter */
  char *line_buf; /* the unfinished line (kLine_buffer), UTF-8 */
  size_t line_len, line_cap;
  unsigned char held[4]; /* the decoder's incomplete trailing sequence */
  size_t n_held;
  double saw_return_at, crlf_delay;
  /* stdin bytes that arrived while paused */
  char *parked;
  size_t parked_len, parked_cap;
  RlIter *iter;
  ScrDyn *abort_dispose; /* the signal option's listener disposable (+1) */
  struct ScrRl *next;
} ScrRl;

static SCR_TL ScrRl *scr_rls = NULL;
static SCR_TL double scr_rl_next_id = 1;
static SCR_TL size_t scr_rl_stdin_open = 0; /* open stdin interfaces */
static SCR_TL ScrClosure *scr_rl_data_cb = NULL; /* the shared stdin consumer (borrowed) */
static SCR_TL bool scr_rl_end_registered = false;

static ScrRl *scr_rl_find(double id) {
  for (ScrRl *rl = scr_rls; rl; rl = rl->next) {
    if (rl->id == id) return rl;
  }
  return NULL;
}

static void scr_rl_throw_closed(void) {
  static const char m[] = "readline was closed";
  scr_throw_error_msg_code(SCR_ERR_ERROR, m, sizeof m - 1, "ERR_USE_AFTER_CLOSE");
}

/* ── listeners ─────────────────────────────────────────────────────── */

static void scr_rl_add(ScrRl *rl, int ev, ScrClosure *cb /*moves*/, void *fn, bool once, bool iter) {
  RlList *l = &rl->ev[ev];
  l->v = scr_rl_grow(l->v, &l->cap, l->n + 1, sizeof *l->v);
  l->v[l->n++] = (RlEntry){cb, fn, once, iter};
}

static void scr_rl_remove_iter(ScrRl *rl) {
  for (int ev = 0; ev < RL_EV_COUNT; ev++) {
    RlList *l = &rl->ev[ev];
    size_t k = 0;
    for (size_t i = 0; i < l->n; i++) {
      if (!l->v[i].iter) l->v[k++] = l->v[i];
    }
    l->n = k;
  }
}

static void scr_rl_iter_line(ScrRl *rl, ScrStr *line /*moves*/);
static void scr_rl_iter_error(ScrRl *rl, ScrError *err);
static void scr_rl_iter_close(ScrRl *rl);

/* emit(ev, ...): a snapshot in listener order; once-listeners leave before
 * they run (Node's onceWrapper). `line` is borrowed (each line listener
 * receives its own +1); `err` is borrowed. */
static void scr_rl_emit(ScrRl *rl, int ev, ScrStr *line, ScrError *err) {
  RlList *l = &rl->ev[ev];
  size_t n = l->n;
  if (n == 0) return;
  RlEntry *snap = malloc(n * sizeof *snap);
  if (!snap) scr_rl_oom();
  memcpy(snap, l->v, n * sizeof *snap);
  for (size_t i = 0; i < n; i++) {
    if (!snap[i].iter) scr_closure_retain(snap[i].cb);
  }
  size_t k = 0;
  for (size_t i = 0; i < l->n; i++) {
    if (l->v[i].once) {
      if (!l->v[i].iter) scr_closure_release(l->v[i].cb);
    } else {
      l->v[k++] = l->v[i];
    }
  }
  l->n = k;
  for (size_t i = 0; i < n; i++) {
    RlEntry e = snap[i];
    if (!scr_exc_pending()) {
      if (e.iter) {
        if (ev == RL_EV_LINE) scr_rl_iter_line(rl, scr_str_retain(line));
        else if (ev == RL_EV_ERROR) scr_rl_iter_error(rl, err);
        else if (ev == RL_EV_CLOSE) scr_rl_iter_close(rl);
      } else if (ev == RL_EV_LINE) {
        ((ScrRlLineFn)e.fn)(e.cb, scr_str_retain(line));
      } else if (ev == RL_EV_ERROR) {
        ((ScrRlErrFn)e.fn)(e.cb, err);
      } else {
        ((void (*)(ScrClosure *))e.cb->fn)(e.cb);
      }
    }
    if (!e.iter) scr_closure_release(e.cb);
  }
  free(snap);
}

/* ── output, pause/resume ──────────────────────────────────────────── */

static void scr_rl_write_out(ScrRl *rl, ScrStr *text) {
  if (rl->out) rl->io->write(rl->out, text);
  else if (rl->out_stdout) scr_stdio_write_str(1, text);
}

static void scr_rl_feed_bytes(ScrRl *rl, const char *p, size_t n);

/* pause()/resume() without the closed check (Node's methods throw on a
 * closed interface; close() itself pauses first). */
static void scr_rl_do_pause(ScrRl *rl) {
  if (rl->paused) return;
  if (rl->in) rl->io->pause(rl->in);
  rl->paused = true;
  scr_rl_emit(rl, RL_EV_PAUSE, NULL, NULL);
}

static void scr_rl_do_resume(ScrRl *rl) {
  if (!rl->paused) return;
  if (rl->in) rl->io->resume(rl->in);
  rl->paused = false;
  scr_rl_emit(rl, RL_EV_RESUME, NULL, NULL);
  /* stdin bytes that arrived while paused (the pipe holds them in Node) */
  if (rl->stdin_in && rl->parked_len > 0 && !rl->closed) {
    char *p = rl->parked;
    size_t n = rl->parked_len;
    rl->parked = NULL;
    rl->parked_len = rl->parked_cap = 0;
    scr_rl_feed_bytes(rl, p, n);
    free(p);
  }
}

static void scr_rl_prompt_now(ScrRl *rl) {
  if (rl->paused) scr_rl_do_resume(rl);
  if (scr_exc_pending()) return;
  scr_rl_write_out(rl, rl->prompt);
}

/* ── close ─────────────────────────────────────────────────────────── */

static void scr_rl_detach_stdin(ScrRl *rl) {
  if (!rl->stdin_in || rl->dead) return;
  if (scr_rl_stdin_open > 0) scr_rl_stdin_open--;
  /* The last stdin interface leaving detaches the shared consumer so the
   * loop stops waiting on fd 0 (Node's pause-on-close). */
  if (scr_rl_stdin_open == 0 && scr_rl_data_cb != NULL) {
    scr_stdin_remove_data(scr_rl_data_cb);
    scr_rl_data_cb = NULL;
  }
}

static void scr_rl_settle_close(ScrRl *rl) {
  if (rl->closed) return;
  scr_rl_do_pause(rl);
  if (scr_exc_pending()) return;
  rl->closed = true;
  /* onSelfCloseWithoutTerminal: the input listeners go first (they were
   * registered at construction). */
  if (rl->in) {
    rl->io->detach(rl->in, rl->id);
    rl->io->release(rl->in);
    rl->in = NULL;
  }
  scr_rl_detach_stdin(rl);
  if (rl->abort_dispose) {
    ScrDyn *d = rl->abort_dispose;
    rl->abort_dispose = NULL;
    ScrDyn *r = scr_dyn_call(d, NULL, 0, "dispose");
    if (r) scr_dyn_release(r);
    scr_dyn_release(d);
  }
  if (rl->q_cb) {
    scr_closure_release(rl->q_cb); /* a pending question never answers */
    rl->q_cb = NULL;
  }
  scr_rl_emit(rl, RL_EV_CLOSE, NULL, NULL);
  free(rl->line_buf);
  rl->line_buf = NULL;
  rl->line_len = rl->line_cap = 0;
  free(rl->parked);
  rl->parked = NULL;
  rl->parked_len = rl->parked_cap = 0;
  if (rl->out) {
    rl->io->release(rl->out);
    rl->out = NULL;
  }
}

/* ── lines ─────────────────────────────────────────────────────────── */

/* kOnLine: a pending question takes the line, else 'line'. Moves line. */
static void scr_rl_on_line(ScrRl *rl, ScrStr *line) {
  if (rl->q_cb) {
    ScrClosure *cb = rl->q_cb;
    ScrRlLineFn fn = rl->q_fn;
    rl->q_cb = NULL;
    if (rl->old_prompt) {
      scr_str_release(rl->prompt);
      rl->prompt = rl->old_prompt;
      rl->old_prompt = NULL;
    }
    fn(cb, line);
    scr_closure_release(cb);
    return;
  }
  scr_rl_emit(rl, RL_EV_LINE, line, NULL);
  scr_str_release(line);
}

static void scr_rl_buf_append(ScrRl *rl, const char *p, size_t n) {
  rl->line_buf = scr_rl_grow(rl->line_buf, &rl->line_cap, rl->line_len + n + 1, 1);
  memcpy(rl->line_buf + rl->line_len, p, n);
  rl->line_len += n;
}

/* kNormalWrite over decoded UTF-8 text. */
static void scr_rl_feed_text(ScrRl *rl, const char *p, size_t n) {
  if (rl->saw_return_at != 0 && scr_now_ms() - rl->saw_return_at <= rl->crlf_delay) {
    if (n > 0 && p[0] == '\n') {
      p++;
      n--;
    }
    rl->saw_return_at = 0;
  }
  bool ending = false;
  for (size_t i = 0; i < n && !ending; i++) ending = p[i] == '\n' || p[i] == '\r';
  if (!ending) {
    if (n > 0) scr_rl_buf_append(rl, p, n);
    return;
  }
  /* The unfinished line joins the new text; the scan runs over both. */
  char *text = p ? (char *)p : (char *)"";
  size_t len = n;
  char *joined = NULL;
  if (rl->line_len > 0) {
    joined = malloc(rl->line_len + n);
    if (!joined) scr_rl_oom();
    memcpy(joined, rl->line_buf, rl->line_len);
    memcpy(joined + rl->line_len, p, n);
    text = joined;
    len = rl->line_len + n;
  }
  rl->line_len = 0;
  rl->saw_return_at = len > 0 && text[len - 1] == '\r' ? scr_now_ms() : 0;
  /* Split first (the remainder becomes the new unfinished line before any
   * line is delivered, as in Node), then deliver in order. */
  size_t n_lines = 0, cap_lines = 0;
  ScrStr **lines = NULL;
  size_t start = 0;
  for (size_t i = 0; i < len; i++) {
    size_t adv;
    if (text[i] == '\n') adv = 1;
    else if (text[i] == '\r') adv = i + 1 < len && text[i + 1] == '\n' ? 2 : 1;
    else continue;
    lines = scr_rl_grow(lines, &cap_lines, n_lines + 1, sizeof *lines);
    lines[n_lines++] = scr_str_new(text + start, i - start);
    i += adv - 1;
    start = i + 1;
  }
  if (start < len) scr_rl_buf_append(rl, text + start, len - start);
  free(joined);
  for (size_t i = 0; i < n_lines; i++) {
    if (rl->closed || scr_exc_pending()) {
      scr_str_release(lines[i]);
      continue;
    }
    scr_rl_on_line(rl, lines[i]);
  }
  free(lines);
}

/* The length of an incomplete UTF-8 sequence ending the buffer (0 when the
 * buffer ends on a complete sequence or invalid bytes). */
static size_t scr_rl_incomplete_tail(const unsigned char *p, size_t n) {
  for (size_t back = 1; back <= 3 && back <= n; back++) {
    unsigned char c = p[n - back];
    if ((c & 0xC0) == 0x80) continue; /* a continuation byte */
    size_t need = c >= 0xF0 && c <= 0xF4   ? 4
                  : c >= 0xE0 && c <= 0xEF ? 3
                  : c >= 0xC2 && c <= 0xDF ? 2
                                           : 0;
    return need > back ? back : 0;
  }
  return 0;
}

/* decoder.write(bytes) then kNormalWrite. */
static void scr_rl_feed_bytes(ScrRl *rl, const char *p, size_t n) {
  if (rl->stdin_in && rl->paused && !rl->closed) {
    rl->parked = scr_rl_grow(rl->parked, &rl->parked_cap, rl->parked_len + n, 1);
    memcpy(rl->parked + rl->parked_len, p, n);
    rl->parked_len += n;
    return;
  }
  size_t total = rl->n_held + n;
  unsigned char *all = malloc(total ? total : 1);
  if (!all) scr_rl_oom();
  memcpy(all, rl->held, rl->n_held);
  memcpy(all + rl->n_held, p, n);
  size_t tail = scr_rl_incomplete_tail(all, total);
  rl->n_held = tail;
  memcpy(rl->held, all + total - tail, tail);
  ScrStr *text = scr_str_from_utf8_lossy(all, total - tail);
  free(all);
  scr_rl_feed_text(rl, text->data, text->len);
  scr_str_release(text);
}

/* The input ended: a non-empty unfinished line is emitted as 'line' (not
 * offered to a pending question), then close(). */
static void scr_rl_feed_end(ScrRl *rl) {
  if (rl->closed) return;
  if (rl->line_len > 0) {
    ScrStr *line = scr_str_new(rl->line_buf, rl->line_len);
    rl->line_len = 0;
    scr_rl_emit(rl, RL_EV_LINE, line, NULL);
    scr_str_release(line);
    if (scr_exc_pending()) return;
  }
  scr_rl_settle_close(rl);
}

void scr_rl_input_bytes(double id, ScrBytes *chunk) {
  ScrRl *rl = scr_rl_find(id);
  if (!rl || rl->closed) return;
  char *p = malloc(chunk->len ? chunk->len : 1);
  if (!p) scr_rl_oom();
  scr_bytes_read(chunk, 0, p, chunk->len);
  scr_rl_feed_bytes(rl, p, chunk->len);
  free(p);
}

void scr_rl_input_str(double id, ScrStr *chunk) {
  ScrRl *rl = scr_rl_find(id);
  if (!rl || rl->closed) return;
  scr_rl_feed_text(rl, chunk->data, chunk->len);
}

void scr_rl_input_end(double id) {
  ScrRl *rl = scr_rl_find(id);
  if (rl) scr_rl_feed_end(rl);
}

/* The input's 'error' becomes the interface's: with no listener (the
 * iterator counts as one), it is thrown, as EventEmitter's emit('error')
 * throws. */
void scr_rl_input_error(double id, ScrError *err) {
  ScrRl *rl = scr_rl_find(id);
  if (!rl) return;
  if (rl->ev[RL_EV_ERROR].n == 0) {
    scr_throw_obj(scr_error_retain(err), &scr_error_retain_v, &scr_error_release_v,
                  scr_error_trace_arg());
    return;
  }
  scr_rl_emit(rl, RL_EV_ERROR, NULL, err);
}

/* ── stdin input ───────────────────────────────────────────────────── */

/* The shared stdin consumer: every open stdin interface gets each chunk. */
static void scr_rl_data_adapter(ScrClosure *cb, ScrBytes *chunk) {
  (void)cb;
  for (ScrRl *rl = scr_rls; rl; rl = rl->next) {
    if (rl->closed || rl->dead || !rl->stdin_in) continue;
    scr_rl_input_bytes(rl->id, chunk);
    if (scr_exc_pending()) return;
  }
}

static void scr_rl_end_thunk(ScrClosure *cb) {
  (void)cb;
  scr_rl_data_cb = NULL; /* the stdin unit dropped its listeners itself */
  for (ScrRl *rl = scr_rls; rl; rl = rl->next) {
    if (rl->closed || rl->dead || !rl->stdin_in) continue;
    if (rl->parked_len > 0) {
      /* parked bytes still end their lines before the input ends */
      bool paused = rl->paused;
      rl->paused = false;
      char *p = rl->parked;
      size_t n = rl->parked_len;
      rl->parked = NULL;
      rl->parked_len = rl->parked_cap = 0;
      scr_rl_feed_bytes(rl, p, n);
      free(p);
      rl->paused = paused;
      if (scr_exc_pending()) return;
    }
    scr_rl_feed_end(rl);
    if (scr_exc_pending()) return;
  }
}

/* ── async iteration (events.on) ───────────────────────────────────── */

static void scr_rl_iter_settle_done(ScrPromise *p) {
  scr_promise_fulfill_ref(p, scr_dyn_retain(scr_dyn_undefined()), scr_dyn_retain_v,
                          scr_dyn_release_v, NULL);
}

static void scr_rl_iter_settle_line(ScrPromise *p, ScrStr *line /*moves*/) {
  ScrDyn *v = scr_dyn_new_str(line);
  scr_str_release(line);
  scr_promise_fulfill_ref(p, v, scr_dyn_retain_v, scr_dyn_release_v, NULL);
}

static void scr_rl_iter_reject(ScrPromise *p, ScrError *err) {
  scr_throw_obj(scr_error_retain(err), &scr_error_retain_v, &scr_error_release_v,
                scr_error_trace_arg());
  scr_promise_reject_pending(p);
}

static ScrPromise *scr_rl_iter_shift_waiter(RlIter *it) {
  ScrPromise *p = it->waiters[0];
  memmove(it->waiters, it->waiters + 1, (it->wn - 1) * sizeof *it->waiters);
  it->wn--;
  return p;
}

/* closeHandler */
static void scr_rl_iter_close(ScrRl *rl) {
  RlIter *it = rl->iter;
  if (!it) return;
  scr_rl_remove_iter(rl);
  it->finished = true;
  it->paused = false;
  while (it->wn > 0) {
    ScrPromise *p = scr_rl_iter_shift_waiter(it);
    scr_rl_iter_settle_done(p);
    scr_promise_release(p);
  }
}

/* eventHandler */
static void scr_rl_iter_line(ScrRl *rl, ScrStr *line) {
  RlIter *it = rl->iter;
  if (it->finished) {
    scr_str_release(line);
    return;
  }
  if (it->wn > 0) {
    ScrPromise *p = scr_rl_iter_shift_waiter(it);
    scr_rl_iter_settle_line(p, line);
    scr_promise_release(p);
    return;
  }
  it->q = scr_rl_grow(it->q, &it->cap, it->head + it->len + 1, sizeof *it->q);
  it->q[it->head + it->len++] = line;
  if (!it->paused && it->len > 1024) {
    it->paused = true;
    if (!rl->closed) scr_rl_do_pause(rl);
  }
}

/* errorHandler */
static void scr_rl_iter_error(ScrRl *rl, ScrError *err) {
  RlIter *it = rl->iter;
  if (it->wn > 0) {
    ScrPromise *p = scr_rl_iter_shift_waiter(it);
    scr_rl_iter_reject(p, err);
    scr_promise_release(p);
  } else if (!it->error) {
    it->error = scr_error_retain(err);
  }
  scr_rl_iter_close(rl);
}

/* rl[Symbol.asyncIterator](): one iterator per interface, created on the
 * first call; it listens for 'line', 'error' and 'close' from then on. */
void scr_rl_iter_open(double id) {
  ScrRl *rl = scr_rl_find(id);
  if (!rl || rl->iter) return;
  rl->iter = calloc(1, sizeof *rl->iter);
  if (!rl->iter) scr_rl_oom();
  scr_rl_add(rl, RL_EV_LINE, NULL, NULL, false, true);
  scr_rl_add(rl, RL_EV_ERROR, NULL, NULL, false, true);
  scr_rl_add(rl, RL_EV_CLOSE, NULL, NULL, false, true);
}

/* next(): a promise of the next line, or of undefined once done. */
ScrPromise *scr_rl_iter_next(double id) {
  ScrPromise *p = scr_promise_new();
  ScrRl *rl = scr_rl_find(id);
  RlIter *it = rl ? rl->iter : NULL;
  if (!it) {
    scr_rl_iter_settle_done(p);
    return p;
  }
  if (it->len > 0) {
    ScrStr *line = it->q[it->head++];
    it->len--;
    if (it->len == 0) it->head = 0;
    if (it->paused && it->len < 1) {
      it->paused = false;
      if (!rl->closed) scr_rl_do_resume(rl);
    }
    scr_rl_iter_settle_line(p, line);
    return p;
  }
  if (it->error) {
    ScrError *err = it->error;
    it->error = NULL;
    scr_rl_iter_reject(p, err);
    scr_error_release(err);
    return p;
  }
  if (it->finished) {
    scr_rl_iter_settle_done(p);
    return p;
  }
  it->waiters = scr_rl_grow(it->waiters, &it->wcap, it->wn + 1, sizeof *it->waiters);
  it->waiters[it->wn++] = scr_promise_retain(p);
  return p;
}

/* return(): the loop left early. */
void scr_rl_iter_return(double id) {
  ScrRl *rl = scr_rl_find(id);
  if (rl) scr_rl_iter_close(rl);
}

/* ── creation ──────────────────────────────────────────────────────── */

static void scr_rl_iter_free(RlIter *it) {
  for (size_t i = 0; i < it->len; i++) scr_str_release(it->q[it->head + i]);
  free(it->q);
  for (size_t i = 0; i < it->wn; i++) scr_promise_release(it->waiters[i]);
  free(it->waiters);
  if (it->error) scr_error_release(it->error);
  free(it);
}

/* Exit-time cleanup (the events-unit precedent, before the RC audit):
 * whatever an interface still holds releases here. */
static void scr_rl_cleanup_atexit(void) {
  ScrRl *rl = scr_rls;
  scr_rls = NULL;
  while (rl) {
    ScrRl *next = rl->next;
    if (rl->q_cb) scr_closure_release(rl->q_cb);
    for (int ev = 0; ev < RL_EV_COUNT; ev++) {
      for (size_t i = 0; i < rl->ev[ev].n; i++) {
        if (!rl->ev[ev].v[i].iter) scr_closure_release(rl->ev[ev].v[i].cb);
      }
      free(rl->ev[ev].v);
    }
    if (rl->iter) scr_rl_iter_free(rl->iter);
    if (rl->abort_dispose) scr_dyn_release(rl->abort_dispose);
    if (rl->in) rl->io->release(rl->in);
    if (rl->out) rl->io->release(rl->out);
    scr_str_release(rl->prompt);
    if (rl->old_prompt) scr_str_release(rl->old_prompt);
    free(rl->line_buf);
    free(rl->parked);
    free(rl);
    rl = next;
  }
}

static void scr_rl_close_job(ScrClosure *job) {
  ScrRl *rl = scr_rl_find(scr_box_get_f64(job->caps[0]));
  if (rl) scr_rl_settle_close(rl);
}

static ScrDyn *scr_rl_abort_thunk(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  (void)args;
  (void)argc;
  ScrRl *rl = scr_rl_find(scr_box_get_f64(clo->caps[0]));
  if (rl) scr_rl_settle_close(rl);
  return scr_dyn_retain(scr_dyn_undefined());
}

/* validateAbortSignal(signal, 'options.signal'): the aborted flag (0 or
 * 1), or -1 with ERR_INVALID_ARG_TYPE pending for a value that is not an
 * AbortSignal. */
static int scr_rl_signal_aborted(ScrDyn *signal) {
  ScrDyn *aborted = NULL;
  if (signal->kind == SCR_DYN_OBJ) {
    ScrDyn *v = scr_dyn_obj_get(signal, "aborted", 7);
    aborted = v ? scr_dyn_retain(v) : NULL;
  } else if (signal->kind == SCR_DYN_HANDLE) {
    ScrStr *k = scr_str_new("aborted", 7);
    aborted = scr_dyn_handle_key_get(signal, k);
    scr_str_release(k);
  }
  if (!aborted) {
    scr_dyn_prop_type_fail("options.signal", "an instance of AbortSignal", signal);
    return -1;
  }
  int r = scr_dyn_truthy(aborted) ? 1 : 0;
  scr_dyn_release(aborted);
  return r;
}

/* The `signal` option: an aborted signal closes the interface on the next
 * tick; otherwise a later abort closes it. */
static void scr_rl_watch_signal(ScrRl *rl, ScrDyn *signal, ScrAbortAddFn add) {
  int state = scr_rl_signal_aborted(signal);
  if (state < 0) return;
  bool is_aborted = state == 1;
  if (is_aborted) {
    ScrClosure *job = scr_closure_new((void *)&scr_rl_close_job, 1);
    job->caps[0] = scr_box_new(SCR_BOX_F64);
    scr_box_set_f64(job->caps[0], rl->id);
    scr_next_tick(job);
    return;
  }
  ScrClosure *clo = scr_closure_new((void *)&scr_rl_abort_thunk, 1);
  clo->caps[0] = scr_box_new(SCR_BOX_F64);
  scr_box_set_f64(clo->caps[0], rl->id);
  ScrDyn *listener = scr_dyn_new_func(clo, &scr_rl_abort_thunk, 0, "()", "onAborted");
  rl->abort_dispose = add(signal, listener);
  scr_dyn_release(listener);
}

/* createInterface: input is a stream (+1, moves; io non-NULL) or NULL for
 * process.stdin; output is a stream (+1, moves), or NULL with out_stdout
 * selecting process.stdout. crlf_delay is Node's option value (0 when
 * absent); prompt is borrowed (NULL: "> "); signal is NULL or a borrowed
 * AbortSignal, `add` its addAbortListener. Answers the interface
 * handle. */
double scr_rl_open(const ScrRlIo *io, void *in, void *out, bool out_stdout, double crlf_delay,
                   ScrStr *prompt, ScrDyn *signal, ScrAbortAddFn add) {
  static SCR_TL bool cleanup_registered = false;
  if (!cleanup_registered) {
    cleanup_registered = true;
    scr_atexit(scr_rl_cleanup_atexit);
  }
  ScrRl *rl = calloc(1, sizeof *rl);
  if (!rl) scr_rl_oom();
  rl->id = scr_rl_next_id++;
  rl->stdin_in = in == NULL;
  rl->io = io;
  rl->in = in;
  rl->out = out;
  rl->out_stdout = out_stdout;
  rl->prompt = prompt ? scr_str_retain(prompt) : scr_str_new("> ", 2);
  /* this.crlfDelay = crlfDelay ? MathMax(kMincrlfDelay, crlfDelay) : kMincrlfDelay */
  rl->crlf_delay = isnan(crlf_delay) || crlf_delay == 0 ? 100 : fmax(100, crlf_delay);
  rl->next = scr_rls;
  scr_rls = rl;
  if (in == NULL) {
    if (scr_stdin_ended()) {
      rl->dead = true; /* a question writes its prompt; nothing answers */
    } else {
      scr_rl_stdin_open++;
      if (scr_rl_data_cb == NULL) {
        scr_rl_data_cb = scr_closure_new((void *)&scr_rl_data_adapter, 0);
        scr_stdin_on_data(scr_rl_data_cb, &scr_rl_data_adapter, false);
      }
      if (!scr_rl_end_registered) {
        scr_rl_end_registered = true;
        scr_stdin_on_end(scr_closure_new((void *)&scr_rl_end_thunk, 0), false);
      }
    }
  }
  if (signal && scr_dyn_truthy(signal)) scr_rl_watch_signal(rl, signal, add);
  return rl->id;
}

/* ── methods ───────────────────────────────────────────────────────── */

/* question(query, cb): throws ERR_USE_AFTER_CLOSE on a closed interface;
 * while a question is pending only the prompt is written again. */
void scr_rl_question(double id, ScrStr *query, ScrClosure *cb /*moves*/, ScrRlLineFn fn) {
  ScrRl *rl = scr_rl_find(id);
  if (!rl || rl->closed) {
    scr_closure_release(cb);
    scr_rl_throw_closed();
    return;
  }
  if (rl->q_cb) {
    scr_closure_release(cb);
    scr_rl_prompt_now(rl);
    return;
  }
  rl->old_prompt = rl->prompt;
  rl->prompt = scr_str_retain(query);
  rl->q_cb = cb;
  rl->q_fn = fn;
  scr_rl_prompt_now(rl);
}

/* The promise question's state, shared by the answer adapter and the abort
 * listener. The signal listener's disposable rides the answer adapter
 * (caps[1]), not this state: the listener holds the state, so the state
 * must not hold the listener. */
typedef struct {
  size_t rc;
  ScrPromise *p;
  ScrDyn *signal; /* +1 or NULL */
  double id;
  bool settled;
} RlAsk;

static void *scr_rl_ask_retain_v(void *a) {
  ((RlAsk *)a)->rc++;
  return a;
}

static void scr_rl_ask_release_v(void *v) {
  RlAsk *a = v;
  if (--a->rc > 0) return;
  scr_promise_release(a->p);
  if (a->signal) scr_dyn_release(a->signal);
  free(a);
}

static void *scr_rl_dyn_retain_v(void *p) { return p ? scr_dyn_retain(p) : NULL; }
static void scr_rl_dyn_release_v(void *p) { scr_dyn_release(p); }

/* Calls and drops a disposable (+1). */
static void scr_rl_dispose(ScrDyn *d) {
  if (!d) return;
  ScrDyn *r = scr_dyn_call(d, NULL, 0, "dispose");
  if (r) scr_dyn_release(r);
  scr_dyn_release(d);
}

/* caps[0] the question state; caps[1] the signal listener's disposable
 * (a dyn value, or an empty box). */
static void scr_rl_ask_answer(ScrClosure *cb, ScrStr *answer) {
  RlAsk *a = scr_box_get_ref(cb->caps[0]); /* +1 */
  scr_rl_dispose(scr_box_get_ref(cb->caps[1]));
  scr_box_set_ref(cb->caps[1], NULL);
  if (!a->settled) {
    a->settled = true;
    scr_promise_fulfill_str(a->p, answer);
  } else {
    scr_str_release(answer);
  }
  scr_rl_ask_release_v(a);
}

/* new AbortError(undefined, { cause: signal.reason }) */
static ScrError *scr_rl_abort_error(ScrDyn *signal) {
  ScrStr *message = scr_str_new("The operation was aborted", 25);
  ScrError *e = scr_error_new(SCR_ERR_ERROR, message);
  scr_str_release(message);
  scr_str_release(e->name);
  e->name = scr_str_new("AbortError", 10);
  /* AbortError assigns code, then name: own enumerable properties */
  scr_error_set_code(e, "ABORT_ERR");
  e->name_present = true;
  e->name_enumerable = true;
  ScrStr *k = scr_str_new("reason", 6);
  ScrDyn *reason = scr_dyn_handle_key_get(signal, k);
  scr_str_release(k);
  scr_error_define_cause(e, reason ? reason : scr_dyn_undefined());
  if (reason) scr_dyn_release(reason);
  return e;
}

static void scr_rl_ask_reject(RlAsk *a, ScrError *e /*moves*/) {
  a->settled = true;
  scr_throw_obj(e, &scr_error_retain_v, &scr_error_release_v, scr_error_trace_arg());
  scr_promise_reject_pending(a->p);
}

/* onAbort: kQuestionCancel (drops whichever question is pending, writing
 * clearLine's "\r\n"), then the rejection. */
static ScrDyn *scr_rl_ask_abort_thunk(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  (void)args;
  (void)argc;
  RlAsk *a = scr_box_get_ref(clo->caps[0]); /* +1 */
  ScrRl *rl = scr_rl_find(a->id);
  if (rl && rl->q_cb) {
    scr_closure_release(rl->q_cb);
    rl->q_cb = NULL;
    if (rl->old_prompt) {
      scr_str_release(rl->prompt);
      rl->prompt = rl->old_prompt;
      rl->old_prompt = NULL;
    }
    ScrStr *crlf = scr_str_new("\r\n", 2);
    scr_rl_write_out(rl, crlf);
    scr_str_release(crlf);
  }
  if (!a->settled) scr_rl_ask_reject(a, scr_rl_abort_error(a->signal));
  scr_rl_ask_release_v(a);
  return scr_dyn_retain(scr_dyn_undefined());
}

/* readline/promises question(query, { signal }): rejects with
 * ERR_USE_AFTER_CLOSE on a closed interface and with an AbortError when
 * the signal is (or becomes) aborted. */
ScrPromise *scr_rl_question_promise(double id, ScrStr *query, ScrDyn *signal, ScrAbortAddFn add) {
  RlAsk *a = calloc(1, sizeof *a);
  if (!a) scr_rl_oom();
  a->rc = 1;
  a->p = scr_promise_new();
  a->id = id;
  ScrDyn *dispose = NULL;
  ScrPromise *result = scr_promise_retain(a->p);
  if (signal && scr_dyn_truthy(signal)) {
    int state = scr_rl_signal_aborted(signal);
    if (state < 0) {
      a->settled = true;
      scr_promise_reject_pending(a->p);
      scr_rl_ask_release_v(a);
      return result;
    }
    bool is_aborted = state == 1;
    a->signal = scr_dyn_retain(signal);
    if (is_aborted) {
      scr_rl_ask_reject(a, scr_rl_abort_error(signal));
      scr_rl_ask_release_v(a);
      return result;
    }
    ScrClosure *clo = scr_closure_new((void *)&scr_rl_ask_abort_thunk, 1);
    clo->caps[0] = scr_box_new_obj(&scr_rl_ask_retain_v, &scr_rl_ask_release_v, NULL);
    scr_box_set_ref(clo->caps[0], scr_rl_ask_retain_v(a));
    ScrDyn *listener = scr_dyn_new_func(clo, &scr_rl_ask_abort_thunk, 0, "()", "onAbort");
    dispose = add(signal, listener);
    scr_dyn_release(listener);
  }
  ScrRl *rl = scr_rl_find(id);
  if (!rl || rl->closed) {
    scr_rl_dispose(dispose);
    static const char m[] = "readline was closed";
    ScrStr *message = scr_str_new(m, sizeof m - 1);
    ScrError *e = scr_error_new(SCR_ERR_ERROR, message);
    scr_str_release(message);
    scr_error_set_code(e, "ERR_USE_AFTER_CLOSE");
    scr_rl_ask_reject(a, e);
    scr_rl_ask_release_v(a);
    return result;
  }
  ScrClosure *cb = scr_closure_new((void *)&scr_rl_ask_answer, 2);
  cb->caps[0] = scr_box_new_obj(&scr_rl_ask_retain_v, &scr_rl_ask_release_v, NULL);
  scr_box_set_ref(cb->caps[0], a); /* the creation reference moves here */
  cb->caps[1] = scr_box_new_obj(&scr_rl_dyn_retain_v, &scr_rl_dyn_release_v, NULL);
  scr_box_set_ref(cb->caps[1], dispose); /* moves (NULL without a signal) */
  scr_rl_question(id, query, cb, &scr_rl_ask_answer);
  return result;
}

void scr_rl_close(double id) {
  ScrRl *rl = scr_rl_find(id);
  if (rl) scr_rl_settle_close(rl); /* twice is a no-op, like Node */
}

void scr_rl_pause(double id) {
  ScrRl *rl = scr_rl_find(id);
  if (!rl || rl->closed) {
    scr_rl_throw_closed();
    return;
  }
  scr_rl_do_pause(rl);
}

void scr_rl_resume(double id) {
  ScrRl *rl = scr_rl_find(id);
  if (!rl || rl->closed) {
    scr_rl_throw_closed();
    return;
  }
  scr_rl_do_resume(rl);
}

void scr_rl_prompt(double id) {
  ScrRl *rl = scr_rl_find(id);
  if (!rl || rl->closed) {
    scr_rl_throw_closed();
    return;
  }
  scr_rl_prompt_now(rl);
}

void scr_rl_set_prompt(double id, ScrStr *prompt) {
  ScrRl *rl = scr_rl_find(id);
  if (!rl) return;
  scr_str_release(rl->prompt);
  rl->prompt = scr_str_retain(prompt);
}

ScrStr *scr_rl_get_prompt(double id) {
  ScrRl *rl = scr_rl_find(id);
  return rl ? scr_str_retain(rl->prompt) : scr_str_new("", 0);
}

/* write(data): the text runs through the line splitter as if it were
 * input. */
void scr_rl_write(double id, ScrStr *data) {
  ScrRl *rl = scr_rl_find(id);
  if (!rl || rl->closed) {
    scr_rl_throw_closed();
    return;
  }
  if (rl->paused) scr_rl_do_resume(rl);
  if (scr_exc_pending()) return;
  scr_rl_feed_text(rl, data->data, data->len);
}

/* on/once for 'line' (fn: the line adapter), 'close', 'pause', 'resume'
 * (fn NULL), and 'error' (fn: the error adapter). Listeners added after
 * 'close' was emitted never run. */
void scr_rl_on(double id, double ev, ScrClosure *cb /*moves*/, void *fn, bool once) {
  ScrRl *rl = scr_rl_find(id);
  if (!rl || ev < 0 || ev >= RL_EV_COUNT) {
    scr_closure_release(cb);
    return;
  }
  scr_rl_add(rl, (int)ev, cb, fn, once, false);
}

/* ── the runtime-provided adapters ─────────────────────────────────── */

/* A zero-param line/answer callback: the text is ignored. */
void scr_rl_answer_thunk0(ScrClosure *cb, ScrStr *answer) {
  scr_str_release(answer);
  ((void (*)(ScrClosure *))cb->fn)(cb);
}

/* An (answer: string) callback — owns the +1 answer per the universal
 * convention. */
void scr_rl_answer_thunk_str(ScrClosure *cb, ScrStr *answer) {
  ((void (*)(ScrClosure *, ScrStr *))cb->fn)(cb, answer);
}

/* An (err: Error) listener. */
void scr_rl_error_thunk(ScrClosure *cb, ScrError *err) {
  ((void (*)(ScrClosure *, ScrError *))cb->fn)(cb, scr_error_retain(err));
}

/* JavaScript listeners take checked-dynamic values (the adapter owns
 * the +1 dyn parameter it passes). */
void scr_rl_answer_thunk_dyn(ScrClosure *cb, ScrStr *answer) {
  ScrDyn *d = scr_dyn_new_str(answer);
  scr_str_release(answer);
  ((void (*)(ScrClosure *, ScrDyn *))cb->fn)(cb, d);
}

void scr_rl_error_thunk_dyn(ScrClosure *cb, ScrError *err) {
  ScrDyn *d = scr_dyn_from_error(err);
  ((void (*)(ScrClosure *, ScrDyn *))cb->fn)(cb, d);
}

void scr_rl_error_thunk0(ScrClosure *cb, ScrError *err) {
  (void)err;
  ((void (*)(ScrClosure *))cb->fn)(cb);
}

/* child_process — listener removal and the recorded terminal signal.
 *
 * A separate runtime unit, selected only by programs that call one of its
 * entries (child.off / removeListener, child.signalCode), so an executable
 * that does not keeps byte-identical code from scr_child.c: adding these
 * functions there changes that unit's `.eh_frame` contribution, which the
 * linker carries into every program that links it.
 *
 * Both families read the registries and the recorded exit signal that
 * scr_child.c owns; the layout lives in scr_child_private.h.
 */
#include "scr_runtime.h"
#include "scr_child_private.h"
#include <string.h>

/* child.signalCode — the signal that terminated the child (Node answers
 * null for a normal exit, while the child runs, and after a spawn
 * failure). The name is the runtime's static signal spelling retained
 * into a fresh +1 ScrStr. */
bool scr_child_has_signal_code(ScrChild *c) { return c->exit_signal != NULL; }
ScrStr *scr_child_signal_code(ScrChild *c) {
  return scr_str_new(c->exit_signal, strlen(c->exit_signal));
}

/* child.off()/removeListener(): remove the most recently registered
 * listener that IS this closure (EventEmitter's identity semantics). The
 * argument is BORROWED — compared, never retained; a value the registry
 * does not hold (a fresh inline arrow, an adapter closure) removes
 * nothing, exactly Node's answer. Removing does not change what the loop
 * watches: a child with no listeners is still reaped. */
void scr_child_off_spawn(ScrChild *c, ScrClosure *cb) {
  for (size_t i = c->n_spawn; i > 0; i--) {
    if (c->spawn_cbs[i - 1] != cb) continue;
    scr_closure_release(c->spawn_cbs[i - 1]);
    memmove(c->spawn_cbs + i - 1, c->spawn_cbs + i, (c->n_spawn - i) * sizeof *c->spawn_cbs);
    c->n_spawn--;
    return;
  }
}

void scr_child_off_exit(ScrChild *c, ScrClosure *cb) {
  for (size_t i = c->n_exit; i > 0; i--) {
    if (c->exit_cbs[i - 1].cb != cb) continue;
    scr_closure_release(c->exit_cbs[i - 1].cb);
    memmove(c->exit_cbs + i - 1, c->exit_cbs + i, (c->n_exit - i) * sizeof *c->exit_cbs);
    c->n_exit--;
    return;
  }
}

void scr_child_off_close(ScrChild *c, ScrClosure *cb) {
  for (size_t i = c->n_close; i > 0; i--) {
    if (c->close_cbs[i - 1].cb != cb) continue;
    scr_closure_release(c->close_cbs[i - 1].cb);
    memmove(c->close_cbs + i - 1, c->close_cbs + i, (c->n_close - i) * sizeof *c->close_cbs);
    c->n_close--;
    return;
  }
}

void scr_child_off_error(ScrChild *c, ScrClosure *cb) {
  for (size_t i = c->n_err; i > 0; i--) {
    if (c->err_cbs[i - 1].cb != cb) continue;
    scr_closure_release(c->err_cbs[i - 1].cb);
    memmove(c->err_cbs + i - 1, c->err_cbs + i, (c->n_err - i) * sizeof *c->err_cbs);
    c->n_err--;
    return;
  }
}

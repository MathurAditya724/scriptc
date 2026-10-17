/* scriptc runtime — node:test (scr_test.c). Included by scr_runtime.h, which
 * says where new declarations go. */
#ifndef SCR_TEST_H
#define SCR_TEST_H

#include "scr_bytes.h"

/* ── node:test (scr_test.c — compiled only when the program imports it;
 * design note atop the file). Registration builds the test tree while
 * module bodies run (describe callbacks execute AT registration, Node's
 * collection phase); the first registration spawns the runner FIBER,
 * which parks one microtask hop and then runs every test sequentially
 * after main returns — sync bodies called on the fiber (its exception
 * cell isolates throws), async bodies awaited through their spawn
 * wrappers. Reporting is Node v24's spec-reporter shape on stdout;
 * durations are real (nondeterministic — harnesses normalize).
 * ScrStr arguments are BORROWED; closures MOVE. `mode`: 0 run, 1 skip,
 * 2 todo. `flags`: 1 = async body, 2 = body takes the TestContext,
 * 4 = { only: true }, 8 = a { timeout } is given. `at` is "file:line:col"
 * of the registration call (the failing-section "test at" line), "" when
 * unknown. `plan` is the { plan } count, -1 without one; `timeout` is the
 * { timeout } in ms, read with flag 8. An out-of-range timeout throws
 * Node's ERR_OUT_OF_RANGE and registers nothing. */
typedef struct ScrTestCtx ScrTestCtx;
ScrTestCtx *scr_testctx_retain(ScrTestCtx *t);
void scr_testctx_release(ScrTestCtx *t);
void *scr_testctx_retain_v(void *t);
void scr_testctx_release_v(void *t);
void scr_test_register(ScrStr *name, double mode, ScrStr *msg, ScrClosure *cb, double flags, ScrStr *at,
                       double plan, double timeout);
void scr_test_suite(ScrStr *name, double mode, ScrStr *msg, ScrClosure *cb, ScrStr *at,
                    double flags);
/* before/after/beforeEach/afterEach on the CURRENT registration parent
 * (`which`: 0 before, 1 after, 2 beforeEach, 3 afterEach). */
void scr_test_hook(double which, ScrClosure *cb, double flags);
/* t.test(...): registers under `t`, runs the subtest INLINE on the
 * runner fiber, and returns the settled promise the `await` consumes (+1). */
ScrPromise *scr_test_sub(ScrTestCtx *t, ScrStr *name, double mode, ScrStr *msg, ScrClosure *cb, double flags, ScrStr *at,
                         double plan, double timeout);
void scr_test_ctx_skip(ScrTestCtx *t, ScrStr *msg);
void scr_test_ctx_todo(ScrTestCtx *t, ScrStr *msg);
void scr_test_ctx_diagnostic(ScrTestCtx *t, ScrStr *msg);
void scr_test_ctx_hook(ScrTestCtx *t, double which, ScrClosure *cb, double flags);
void scr_test_ctx_plan(ScrTestCtx *t, double count);
void scr_test_ctx_count(ScrTestCtx *t);
ScrStr *scr_test_ctx_full_name(ScrTestCtx *t);
ScrStr *scr_test_ctx_name(ScrTestCtx *t); /* +1 */
/* Mock trackers: the module's `mock` and each test's t.mock. track keeps
 * the closure that restores one mock; restore_all calls them in creation
 * order; reset calls them and forgets them. A test's t.mock is reset when
 * the test ends, after its t.after hooks. */
void scr_test_mock_track(ScrClosure *restore);
void scr_test_mock_restore_all(void);
void scr_test_mock_reset(void);
void scr_test_ctx_mock_track(ScrTestCtx *t, ScrClosure *restore);
void scr_test_ctx_mock_restore_all(ScrTestCtx *t);
void scr_test_ctx_mock_reset(ScrTestCtx *t);
/* Main's epilogue (emitted when moduleUsesNodeTest): 1 when any non-todo
 * test failed, Node's exit contract. */
int scr_test_exit_code(void);
#ifdef SCR_RC_AUDIT
long scr_testctx_live_count(void);
#endif

#endif /* SCR_TEST_H */

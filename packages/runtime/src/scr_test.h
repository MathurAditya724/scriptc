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
 * 4 = { only: true }. `at` is "file:line:col" of the registration call
 * (the failing-section "test at" line), "" when unknown. */
typedef struct ScrTestCtx ScrTestCtx;
ScrTestCtx *scr_testctx_retain(ScrTestCtx *t);
void scr_testctx_release(ScrTestCtx *t);
void *scr_testctx_retain_v(void *t);
void scr_testctx_release_v(void *t);
void scr_test_register(ScrStr *name, double mode, ScrStr *msg, ScrClosure *cb, double flags, ScrStr *at);
void scr_test_suite(ScrStr *name, double mode, ScrStr *msg, ScrClosure *cb, ScrStr *at,
                    double flags);
/* before/after/beforeEach/afterEach on the CURRENT registration parent
 * (`which`: 0 before, 1 after, 2 beforeEach, 3 afterEach). */
void scr_test_hook(double which, ScrClosure *cb, double flags);
/* t.test(...): registers under `t`, runs the subtest INLINE on the
 * runner fiber, and returns the settled promise the `await` consumes (+1). */
ScrPromise *scr_test_sub(ScrTestCtx *t, ScrStr *name, double mode, ScrStr *msg, ScrClosure *cb, double flags, ScrStr *at);
void scr_test_ctx_skip(ScrTestCtx *t, ScrStr *msg);
void scr_test_ctx_todo(ScrTestCtx *t, ScrStr *msg);
void scr_test_ctx_diagnostic(ScrTestCtx *t, ScrStr *msg);
void scr_test_ctx_hook(ScrTestCtx *t, double which, ScrClosure *cb, double flags);
void scr_test_ctx_plan(ScrTestCtx *t, double count);
void scr_test_ctx_count(ScrTestCtx *t);
ScrStr *scr_test_ctx_full_name(ScrTestCtx *t);
ScrStr *scr_test_ctx_name(ScrTestCtx *t); /* +1 */
/* Main's epilogue (emitted when moduleUsesNodeTest): 1 when any non-todo
 * test failed, Node's exit contract. */
int scr_test_exit_code(void);
#ifdef SCR_RC_AUDIT
long scr_testctx_live_count(void);
#endif

#endif /* SCR_TEST_H */

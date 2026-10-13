#include "scr_runtime.h"
#include <stdlib.h>
#include <string.h>

/* Stored console methods use the same native rendering as direct output.
 * Reflection, mutation, and further Console APIs remain explicit boundaries. */
static SCR_TL ScrDyn *scr_console_methods[5];
static SCR_TL bool scr_console_registered;
static void scr_console_methods_cleanup(void) {
  for (size_t i = 0; i < 5; i++) {
    ScrDyn *method = scr_console_methods[i];
    scr_console_methods[i] = NULL;
    scr_dyn_release(method);
  }
}

static ScrDyn *scr_console_method_call(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  if (argc > 1 && args[0]->kind == SCR_DYN_STR) {
    ScrStr *format = args[0]->v.str;
    for (size_t i = 0; i + 1 < format->len; i++) if (format->data[i] == '%' &&
        strchr("sdifjoOc%", format->data[i + 1])) {
      static const char message[] = "Format strings through stored console methods have no lowering";
      scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
      return NULL;
    }
  }
  ScrLogArg *rendered = argc ? calloc(argc, sizeof *rendered) : NULL;
  if (argc && !rendered) scr_trap("scriptc: out of memory\n");
  size_t count = 0;
  for (; count < argc; count++) {
    rendered[count].tag = SCR_ARG_STR;
    rendered[count].v.s = scr_insp_dyn_s(args[count], 2);
    if (scr_exc_pending()) break;
  }
  if (!scr_exc_pending()) {
    if (scr_box_get_f64(closure->caps[0]) != 0) scr_console_error(argc, rendered);
    else scr_console_log(argc, rendered);
  }
  for (size_t i = 0; i < argc; i++) scr_str_release(rendered[i].v.s);
  free(rendered);
  return scr_exc_pending() ? NULL : scr_dyn_retain(scr_dyn_undefined());
}

static void *scr_console_retain(void *ptr) { return ptr; }
static void scr_console_release(void *ptr) { (void)ptr; }
static bool scr_console_set(void *ptr, const char *key, size_t len, const ScrDyn *value) {
  (void)ptr; (void)key; (void)len; (void)value;
  static const char message[] = "Mutating the native console has no lowering";
  scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
  return false;
}
static ScrDyn *scr_console_get(void *ptr, const char *key, size_t len) {
  (void)ptr;
  const char *names[] = {"log", "info", "debug", "error", "warn"};
  for (size_t i = 0; i < 5; i++) if (strlen(names[i]) == len && memcmp(names[i], key, len) == 0) {
    if (!scr_console_methods[i]) {
      ScrClosure *closure = scr_closure_new(NULL, 1);
      closure->caps[0] = scr_box_new(SCR_BOX_F64);
      scr_box_set_f64(closure->caps[0], i >= 3 ? 1 : 0);
      scr_console_methods[i] = scr_dyn_new_func(closure, scr_console_method_call, 0, "", names[i]);
    }
    return scr_dyn_retain(scr_console_methods[i]);
  }
  static const char *unsupported[] = {"Console", "assert", "clear", "count", "countReset", "dir", "dirxml", "group", "groupCollapsed", "groupEnd", "table", "time", "timeEnd", "timeLog", "trace", "profile", "profileEnd", "timeStamp", "context", "_stdout", "_stderr"};
  for (size_t i = 0; i < sizeof unsupported / sizeof unsupported[0]; i++)
    if (strlen(unsupported[i]) == len && memcmp(unsupported[i], key, len) == 0) {
      static const char message[] = "This stored console member has no lowering";
      scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
      return NULL;
    }
  return scr_dyn_retain(scr_dyn_undefined());
}
static ScrDyn *scr_console_invoke(void *ptr, ScrDyn *self, const char *key, ScrDyn *const *args, size_t argc, const char *what) {
  (void)self;
  ScrDyn *method = scr_console_get(ptr, key, strlen(key));
  if (!method) return NULL;
  ScrDyn *result = scr_dyn_call(method, args, argc, what);
  scr_dyn_release(method);
  return result;
}
ScrDyn *scr_console_native(void) {
  static const ScrDynHandleOps ops = {"console", scr_console_retain, scr_console_release, scr_console_invoke, scr_console_get, scr_console_set, NULL, NULL};
  if (!scr_console_registered) {
    scr_console_registered = true;
    scr_atexit(scr_console_methods_cleanup);
  }
  scr_dyn_handle_install(SCR_DYNH_CONSOLE, &ops);
  return scr_dyn_new_handle(&scr_console_registered, SCR_DYNH_CONSOLE);
}

/* ── node:console Console instances ──────────────────────────────────
 * The handle owns its targets; scr_console_bind (scr_stream.c) attaches
 * writable streams and installs the stream writer. */

static void *scr_console_inst_retain(void *ptr) {
  ((ScrConsoleInst *)ptr)->rc++;
  return ptr;
}

static void scr_console_inst_release(void *ptr) {
  ScrConsoleInst *inst = ptr;
  if (--inst->rc) return;
  if (inst->stream_drop) inst->stream_drop(inst);
  free(inst);
}

/* text + "\n" to one target (Node's kWriteToConsole with no group
 * indentation): a bound stream receives ONE write; process stdio rides
 * the console output path. Borrows text. */
static void scr_console_inst_print(ScrConsoleInst *inst, int which, ScrStr *text) {
  if (inst->stream[which]) {
    ScrStr *nl = scr_str_new("\n", 1);
    ScrStr *line = scr_str_concat(text, nl);
    scr_str_release(nl);
    inst->stream_write(inst, which, line);
    scr_str_release(line);
    return;
  }
  ScrLogArg arg = {.tag = SCR_ARG_STR};
  arg.v.s = text;
  if (inst->fd[which] == 2) scr_console_error(1, &arg);
  else scr_console_log(1, &arg);
}

/* 0 for the stdout members, 1 for the stderr members, -1 otherwise. */
static int scr_console_member_target(const char *key, size_t len) {
  const char *names[] = {"log", "info", "debug", "error", "warn"};
  for (int i = 0; i < 5; i++)
    if (strlen(names[i]) == len && memcmp(names[i], key, len) == 0) return i >= 3 ? 1 : 0;
  return -1;
}

/* Node binds each method to its instance (stable identity per instance);
 * reading one as a value stays an explicit boundary. */
static ScrDyn *scr_console_inst_get(void *ptr, const char *key, size_t len) {
  (void)ptr;
  if (scr_console_member_target(key, len) >= 0) {
    static const char message[] = "Stored Console instance methods have no lowering; call them on the instance";
    scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
    return NULL;
  }
  static const char message[] = "This Console instance member has no lowering";
  scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
  return NULL;
}

static bool scr_console_inst_set(void *ptr, const char *key, size_t len, const ScrDyn *value) {
  (void)ptr; (void)key; (void)len; (void)value;
  static const char message[] = "Mutating a Console instance has no lowering";
  scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
  return false;
}

/* Dynamic calls render like the stored global methods: every argument
 * through the dyn inspector (strings verbatim), space-joined. */
static ScrDyn *scr_console_inst_invoke(void *ptr, ScrDyn *self, const char *key, ScrDyn *const *args,
                                       size_t argc, const char *what) {
  (void)self; (void)what;
  int which = scr_console_member_target(key, strlen(key));
  if (which < 0) return scr_console_inst_get(ptr, key, strlen(key));
  if (argc > 1 && args[0]->kind == SCR_DYN_STR) {
    ScrStr *format = args[0]->v.str;
    for (size_t i = 0; i + 1 < format->len; i++) if (format->data[i] == '%' &&
        strchr("sdifjoOc%", format->data[i + 1])) {
      static const char message[] = "Format strings through dynamic Console calls have no lowering";
      scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
      return NULL;
    }
  }
  ScrStr **parts = calloc(argc ? 2 * argc : 1, sizeof *parts);
  if (!parts) scr_trap("scriptc: out of memory\n");
  ScrStr *space = scr_str_new(" ", 1);
  size_t n = 0;
  for (size_t i = 0; i < argc; i++) {
    ScrStr *rendered = scr_insp_dyn_s(args[i], 2);
    if (scr_exc_pending()) {
      scr_str_release(rendered);
      break;
    }
    if (i) parts[n++] = space;
    parts[n++] = rendered;
  }
  if (!scr_exc_pending()) {
    ScrStr *text = scr_str_concat_parts(parts, n);
    scr_console_inst_print(ptr, which, text);
    scr_str_release(text);
  }
  for (size_t i = 0; i < n; i++) if (parts[i] != space) scr_str_release(parts[i]);
  scr_str_release(space);
  free(parts);
  return scr_exc_pending() ? NULL : scr_dyn_retain(scr_dyn_undefined());
}

ScrDyn *scr_console_new(double out_fd, double err_fd, bool ignore_errors) {
  static const ScrDynHandleOps ops = {"console", scr_console_inst_retain, scr_console_inst_release,
                                      scr_console_inst_invoke, scr_console_inst_get,
                                      scr_console_inst_set, NULL, NULL};
  scr_dyn_handle_install(SCR_DYNH_CONSOLE_INSTANCE, &ops);
  ScrConsoleInst *inst = calloc(1, sizeof *inst);
  if (!inst) scr_trap("scriptc: out of memory\n");
  inst->rc = 1;
  inst->fd[0] = out_fd;
  inst->fd[1] = err_fd;
  inst->ignore_errors = ignore_errors;
  ScrDyn *d = scr_dyn_new_handle(inst, SCR_DYNH_CONSOLE_INSTANCE); /* retains */
  scr_console_inst_release(inst);
  return d;
}

void scr_console_inst_write(ScrDyn *console, ScrStr *text, bool to_stderr) {
  if (console->kind == SCR_DYN_HANDLE && console->v.handle.tag == SCR_DYNH_CONSOLE_INSTANCE) {
    scr_console_inst_print(console->v.handle.ptr, to_stderr ? 1 : 0, text);
    return;
  }
  if (console->kind == SCR_DYN_HANDLE && console->v.handle.tag == SCR_DYNH_CONSOLE) {
    ScrLogArg arg = {.tag = SCR_ARG_STR};
    arg.v.s = text;
    if (to_stderr) scr_console_error(1, &arg);
    else scr_console_log(1, &arg);
    return;
  }
  static const char message[] = "This Console value has no lowering";
  scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
}

/* Only programs that expose a stored global need its console provider.
 * Keep the core builtin unit independent of optional inspection code. */
ScrDyn *scr_global_native(ScrArr *known) {
  return scr_global_native_init(known, scr_console_native);
}

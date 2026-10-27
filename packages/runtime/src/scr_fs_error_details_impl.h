/* Private fs Error metadata construction, shared without exporting a new ABI.
 * Include after scr_runtime.h and scr_system_errors.h. */
#ifndef SCR_FS_ERROR_DETAILS_IMPL_H
#define SCR_FS_ERROR_DETAILS_IMPL_H

static ScrError *scr_fs_error_details(int e, const char *name, const char *message, size_t length,
                                      const char *op, const ScrStr *path, const ScrStr *dest) {
  double number = e > 0 ? -e : e;
#define SCR_FS_ERRNO_VALUE(code, text) if (strcmp(name, #code) == 0) number = SCR_NODE_UV__##code;
  SCR_NODE_UV_ERRNO_MAP(SCR_FS_ERRNO_VALUE)
#undef SCR_FS_ERRNO_VALUE
  ScrStr *text = scr_str_new(message, length);
  ScrError *error = scr_error_new(SCR_ERR_ERROR, text);
  scr_str_release(text);
  scr_error_set_code(error, name);
  error->system_errno = number;
  error->system_call = scr_str_new(op, strlen(op));
  error->system_path = path ? scr_str_retain((ScrStr *)path) : NULL;
  error->system_dest = dest ? scr_str_retain((ScrStr *)dest) : NULL;
  return error;
}

static void scr_fs_throw_details(int e, const char *name, const char *message, size_t length,
                                 const char *op, const ScrStr *path, const ScrStr *dest) {
  ScrError *error = scr_fs_error_details(e, name, message, length, op, path, dest);
  scr_throw_obj(error, &scr_error_retain_v, &scr_error_release_v, scr_error_trace_arg());
}

#endif /* SCR_FS_ERROR_DETAILS_IMPL_H */

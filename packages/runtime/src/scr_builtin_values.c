/* Builtin functions called as function values in JavaScript dependencies
 * (`Buffer.byteLength.bind(Buffer)`, `var alloc = Buffer.alloc`, a stored
 * `fs.realpathSync`): the arguments arrive unchecked, so these entries apply
 * Node's argument handling before the ordinary operation. A separate unit,
 * linked only by programs that read these values. */
#include "scr_runtime.h"

#include <stdio.h>
#include <string.h>

/* Buffer.byteLength called as a function value (`Buffer.byteLength.bind(
 * Buffer)` in truncate-utf8-bytes), with the encoding known only at run
 * time. Node's ladder: a non-string source answers its byte length or
 * throws before the encoding is read; an empty string answers 0; a falsy
 * encoding, or one getEncodingOps does not know after ToString (any ASCII
 * case), counts UTF-8. */
double scr_buffer_byte_length_value(ScrDyn *value, ScrDyn *encoding) {
  static const struct { const char *from; const char *to; } map[] = {
    {"utf8", "utf8"}, {"utf-8", "utf8"}, {"hex", "hex"},
    {"base64", "base64"}, {"base64url", "base64url"},
    {"latin1", "latin1"}, {"binary", "latin1"}, {"ascii", "ascii"},
    {"utf16le", "utf16le"}, {"utf-16le", "utf16le"},
    {"ucs2", "utf16le"}, {"ucs-2", "utf16le"},
  };
  const char *name = "utf8";
  if (value->kind == SCR_DYN_STR && value->v.str->len > 0 && scr_dyn_truthy(encoding)) {
    ScrStr *raw = scr_dyn_string_coerce_js(encoding);
    if (!raw) return 0;
    for (size_t i = 0; i < sizeof map / sizeof map[0]; i++) {
      size_t n = strlen(map[i].from);
      bool same = raw->len == n;
      for (size_t k = 0; same && k < n; k++) {
        char c = raw->data[k];
        if (c >= 'A' && c <= 'Z') c = (char)(c + ('a' - 'A'));
        same = c == map[i].from[k];
      }
      if (same) {
        name = map[i].to;
        break;
      }
    }
    scr_str_release(raw);
  }
  ScrStr *canonical = scr_str_new(name, strlen(name));
  double length = scr_buffer_byte_length_dyn(value, canonical);
  scr_str_release(canonical);
  return length;
}

/* Buffer.alloc called as a function value (`var alloc = Buffer.alloc` in
 * tar-stream): the size must be a number, ERR_INVALID_ARG_TYPE otherwise,
 * then Node's allocation and range checks. The fill argument rides the
 * compiled caller. +1, or NULL with the exception pending. */
ScrBytes *scr_buffer_alloc_value(const ScrDyn *size) {
  if (size->kind != SCR_DYN_NUM) {
    scr_dyn_arg_type_fail("size", "of type number", size);
    return NULL;
  }
  return scr_buffer_alloc(size->v.num);
}

/* fs.realpathSync and fs.realpathSync.native called as function values
 * (fs.realpath keeps `var origRealpathSync = fs.realpathSync`). Node's
 * argument handling: options that are null, undefined or a function mean
 * none, a string is the encoding, an object supplies `encoding`, anything
 * else throws ERR_INVALID_ARG_TYPE; a path that is not a string converts
 * with ToString (a Buffer decodes as UTF-8). The result is a string for
 * utf8, a Buffer for "buffer", and the UTF-8 bytes decoded in any other
 * encoding, whose name must be one Node knows. +1 or NULL. */
ScrDyn *scr_fs_realpath_value(const ScrDyn *path, const ScrDyn *options, bool native) {
  const ScrDyn *encoding = NULL;
  if (options->kind == SCR_DYN_STR) {
    encoding = options;
  } else if (options->kind == SCR_DYN_OBJ) {
    encoding = scr_dyn_obj_get(options, "encoding", 8);
  } else if (options->kind != SCR_DYN_UNDEF && options->kind != SCR_DYN_NULL &&
             options->kind != SCR_DYN_FUNC) {
    scr_dyn_arg_type_fail("options", "of type string or an instance of Object", options);
    return NULL;
  }
  static const struct { const char *from; const char *to; } names[] = {
    {"utf8", "utf8"}, {"utf-8", "utf8"}, {"hex", "hex"}, {"base64", "base64"},
    {"base64url", "base64url"}, {"latin1", "latin1"}, {"binary", "latin1"},
    {"ascii", "ascii"}, {"utf16le", "utf16le"}, {"utf-16le", "utf16le"},
    {"ucs2", "utf16le"}, {"ucs-2", "utf16le"}, {"buffer", "buffer"},
  };
  const char *canonical = "utf8";
  if (encoding && encoding->kind != SCR_DYN_UNDEF && encoding->kind != SCR_DYN_NULL &&
      !(encoding->kind == SCR_DYN_STR && encoding->v.str->len == 0)) {
    const char *found = NULL;
    if (encoding->kind == SCR_DYN_STR) {
      for (size_t i = 0; i < sizeof names / sizeof names[0] && !found; i++) {
        size_t n = strlen(names[i].from);
        if (encoding->v.str->len != n) continue;
        bool same = true;
        for (size_t k = 0; k < n && same; k++) {
          char c = encoding->v.str->data[k];
          if (c >= 'A' && c <= 'Z') c = (char)(c + ('a' - 'A'));
          same = c == names[i].from[k];
        }
        if (same) found = names[i].to;
      }
    }
    if (!found) {
      ScrStr *shown = scr_dyn_string_coerce_js(encoding);
      if (!shown) return NULL;
      char msg[256];
      int n = snprintf(msg, sizeof msg, "The argument 'encoding' is invalid encoding. Received '%.*s'",
                       (int)(shown->len > 160 ? 160 : shown->len), shown->data);
      scr_str_release(shown);
      scr_throw_error_msg_code(SCR_ERR_TYPE, msg, (size_t)n, "ERR_INVALID_ARG_VALUE");
      return NULL;
    }
    canonical = found;
  }
  ScrStr *p = path->kind == SCR_DYN_STR ? scr_str_retain(path->v.str) : scr_dyn_string_coerce_js(path);
  if (!p) return NULL;
  ScrStr *resolved = native ? scr_fs_realpath_promise(p) : scr_fs_realpath(p);
  scr_str_release(p);
  if (!resolved) return NULL;
  ScrDyn *out;
  if (!strcmp(canonical, "utf8")) {
    out = scr_dyn_new_str(resolved);
  } else {
    ScrStr *utf8 = scr_str_new("utf8", 4);
    ScrBytes *bytes = scr_buffer_from_str(resolved, utf8);
    scr_str_release(utf8);
    if (!strcmp(canonical, "buffer")) {
      out = scr_dyn_new_buffer(bytes);
    } else {
      ScrStr *enc = scr_str_new(canonical, strlen(canonical));
      ScrStr *text = scr_bytes_to_str(bytes, enc);
      scr_str_release(enc);
      out = scr_dyn_new_str(text);
      scr_str_release(text);
    }
    scr_bytes_release(bytes);
  }
  scr_str_release(resolved);
  return out;
}

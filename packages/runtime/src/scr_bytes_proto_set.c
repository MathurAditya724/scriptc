/* Borrowed typed-array methods live in their own optional runtime unit so
 * adding support leaves existing method-dispatch objects unchanged. */
#include "scr_runtime.h"

#include <math.h>

/* Borrow the builtin without consulting a receiver's own `set` property. */
ScrDyn *scr_dyn_typed_array_proto_set(ScrDyn *target, ScrDyn *source, ScrDyn *offset) {
  if (target->kind != SCR_DYN_BYTES || target->v.bytes->is_data_view) {
    scr_throw_error(SCR_ERR_TYPE, scr_str_new("this is not a typed array.", 26));
    return NULL;
  }
  double index;
  if (!scr_dyn_number_coerce_js(offset, &index)) return NULL;
  index = isnan(index) ? 0 : trunc(index);
  /* DataView and boxed non-string primitives have no array-like length. */
  if ((source->kind == SCR_DYN_BYTES && source->v.bytes->is_data_view) ||
      source->kind == SCR_DYN_BIGINT || source->kind == SCR_DYN_SYMBOL) {
    if (!(index >= 0) || index > (double)target->v.bytes->len) {
      static const char msg[] = "offset is out of bounds";
      scr_throw_error_msg(SCR_ERR_RANGE, msg, sizeof msg - 1);
      return NULL;
    }
    return scr_dyn_retain(scr_dyn_undefined());
  }
  scr_bytes_set_from_dyn(target->v.bytes, source, index);
  return scr_exc_pending() ? NULL : scr_dyn_retain(scr_dyn_undefined());
}

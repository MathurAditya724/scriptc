#undef NDEBUG
#include "scr_runtime.h"
#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <unistd.h>

static off_t observed_position;
static unsigned reads;

/* Observe the OS boundary: real EOF reads cannot distinguish adjacent
 * offsets above 2^53, so they alone would miss a rounded BigInt. */
ssize_t pread(int fd, void *buffer, size_t length, off_t position) {
  assert(fd == 99 && buffer != NULL && length == 1);
  observed_position = position;
  reads++;
  return 0;
}

static void read_position(int64_t position) {
  ScrDyn *fd = scr_dyn_new_num(99);
  ScrBytes *bytes = scr_bytes_new(SCR_BYTES_U8, 1);
  ScrDyn *buffer = scr_dyn_new_bytes(bytes);
  ScrDyn *zero = scr_dyn_new_num(0);
  ScrDyn *one = scr_dyn_new_num(1);
  ScrBigInt *integer = scr_bigint_from_i64(position);
  ScrDyn *at = scr_dyn_new_bigint(integer);
  unsigned before = reads;
  double count = scr_fs_read_sync_dyn(fd, buffer, zero, one, at);
  assert(!scr_exc_pending());
  assert(count == 0 && reads == before + 1);
  assert(observed_position == position);
  scr_dyn_release(fd);
  scr_dyn_release(buffer);
  scr_dyn_release(zero);
  scr_dyn_release(one);
  scr_dyn_release(at);
  scr_bigint_release(integer);
  scr_bytes_release(bytes);
}

int main(void) {
  scr_init();
  read_position(INT64_C(0));
  read_position(INT64_C(1));
  read_position(INT64_C(9007199254740991));
  read_position(INT64_C(9007199254740992));
  read_position(INT64_C(9007199254740993));
  read_position(INT64_C(9223372036854775806));
  puts("BigInt read positions reach the OS without rounding");
}

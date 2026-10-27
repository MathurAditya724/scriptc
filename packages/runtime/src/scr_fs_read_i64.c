/* Exact signed-64-bit reads for BigInt positions. The existing Number entry
 * stays in scr_lib.c; both include the same OS, shared-buffer and error code. */
#include "scr_runtime.h"
#include "scr_system_errors.h"

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#ifdef _WIN32
#include <io.h>
#include <windows.h>
#endif

#include "scr_fs_errno_impl.h"
#include "scr_fs_error_details_impl.h"
#define SCR_FS_READ_POSITION int64_t
#include "scr_fs_pread_impl.h"
#undef SCR_FS_READ_POSITION

double scr_fs_read_sync_i64(double fd, ScrBytes *buf, size_t off, size_t want,
                            int64_t position) {
#include "scr_fs_read_body_impl.h"
}

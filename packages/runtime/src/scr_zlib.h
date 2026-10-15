/* scriptc runtime — zlib (scr_zlib.c). Included by scr_runtime.h, which says
 * where new declarations go. */
#ifndef SCR_ZLIB_H
#define SCR_ZLIB_H

#include "scr_bytes.h"

/* ── zlib (scr_zlib.c — compiled and linked with -lz only when the
 * program uses zlib, like scr_regex.c/libregexp; see native-toolchain.ts) ──────────
 * deflateSync/inflateSync over u8 bytes with Node's default options
 * (zlib format, default level/windowBits). deflate never throws (OOM
 * aborts); inflate of corrupt input THROWS Node's error catchably
 * ("incorrect header check", ...). Borrow their input; results +1. */
ScrBytes *scr_zlib_deflate(const ScrBytes *data);
ScrBytes *scr_zlib_inflate(const ScrBytes *data);

ScrBytes *scr_zlib_deflate_mode(const ScrBytes *data, double mode, double level);
ScrBytes *scr_zlib_inflate_mode(const ScrBytes *data, double mode);
double scr_zlib_crc32(const ScrBytes *data, double value);
typedef void (*ScrZlibBytesFn)(ScrClosure *cb, ScrError *err,
                              ScrBytes *value /* moves, NULL on error */);
void scr_zlib_codec_async(const ScrBytes *data, double mode, bool compressing,
                          ScrClosure *cb /* moves */, ScrZlibBytesFn fn);

#endif /* SCR_ZLIB_H */

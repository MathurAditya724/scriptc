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
/* The stream engine (Node's ZlibContext): one z_stream per zlib stream
 * object, initialized on its first step. scr_zlib_engine_work runs on a
 * worker thread and touches only the engine; every other entry runs on the
 * main thread. The error entries answer true and fill *out (static or
 * engine-owned strings) when Node would emit an error. */
typedef struct ScrZlibEngine ScrZlibEngine;
typedef struct {
  const char *message;
  const char *code;
  int err;
} ScrZlibError;
ScrZlibEngine *scr_zlib_engine_new(int mode, int level, int window_bits, int mem_level,
                                   int strategy, const unsigned char *dict, size_t dict_len,
                                   bool reject_garbage);
void scr_zlib_engine_work(ScrZlibEngine *e, int flush, const unsigned char *in, uint32_t in_len,
                          unsigned char *out, uint32_t out_len);
void scr_zlib_engine_offsets(const ScrZlibEngine *e, uint32_t *avail_in, uint32_t *avail_out);
bool scr_zlib_engine_error(const ScrZlibEngine *e, ScrZlibError *out);
bool scr_zlib_engine_reset(ScrZlibEngine *e, ScrZlibError *out);
bool scr_zlib_engine_params(ScrZlibEngine *e, int level, int strategy, ScrZlibError *out);
void scr_zlib_engine_free(ScrZlibEngine *e);
/* zlib.Deflate, Inflate, Gzip, Gunzip, DeflateRaw, InflateRaw and Unzip
 * (scr_zlib_stream.c — linked when the program uses both zlib and the
 * stream surface): Transform streams over the engine. mode is Node's
 * node_zlib_mode, opts the options value (undefined for none), validated
 * with Node's ladder. The callbacks MOVE in and may be NULL. */
ScrStream *scr_zlib_stream_new(double mode, ScrDyn *opts);
double scr_zlib_stream_bytes_written(ScrStream *s);
void scr_zlib_stream_flush(ScrStream *s, ScrDyn *kind, ScrClosure *cb);
void scr_zlib_stream_params(ScrStream *s, ScrDyn *level, ScrDyn *strategy, ScrClosure *cb);
void scr_zlib_stream_close(ScrStream *s, ScrClosure *cb);
void scr_zlib_stream_reset(ScrStream *s);

#endif /* SCR_ZLIB_H */

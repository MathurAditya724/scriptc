/* node:zlib, the lowered slice: the one-shot zlib/raw-DEFLATE/gzip codecs
 * over u8 bytes with Node's DEFAULT options. Compiled ONLY when the program
 * uses zlib (native-toolchain.ts gates it exactly like scr_regex.c/libregexp),
 * so zlib-free binaries keep their historical link line. Host builds link
 * the system -lz; cross targets link the vendored zlib built per target
 * (ensureZlibObjects in native-toolchain.ts).
 *
 * Compressed OUTPUT bytes are zlib-version-dependent — the differential
 * corpus tests round-trips and fixed-blob inflation, never raw deflate
 * output. deflate of valid input cannot fail (OOM aborts); inflate of
 * corrupt input THROWS Node's catchable Error (zlib's own msg text:
 * "incorrect header check", ...). */
#include "scr_runtime.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <zlib.h>

static void scr_zlib_oom(void) {
  scr_trap("scriptc: out of memory\n");
}

ScrBytes *scr_zlib_deflate(const ScrBytes *data) {
  SCR_BYTES_SNAPSHOT(data);
  uLong srcLen = (uLong)data->len;
  uLong cap = compressBound(srcLen);
  uint8_t *buf = malloc(cap ? cap : 1);
  if (!buf) scr_zlib_oom();
  uLongf outLen = cap;
  int rc = compress2(buf, &outLen, data->data, srcLen, Z_DEFAULT_COMPRESSION);
  if (rc != Z_OK) scr_zlib_oom(); /* Z_MEM_ERROR is the only reachable code */
  ScrBytes *out = scr_bytes_new(SCR_BYTES_U8, (double)outLen);
  memcpy(out->data, buf, outLen);
  free(buf);
  return out;
}

ScrBytes *scr_zlib_inflate(const ScrBytes *data) {
  SCR_BYTES_SNAPSHOT(data);
  z_stream zs;
  memset(&zs, 0, sizeof zs);
  if (inflateInit(&zs) != Z_OK) scr_zlib_oom();
  size_t cap = data->len > 64 ? data->len * 4 : 256;
  uint8_t *buf = malloc(cap);
  if (!buf) scr_zlib_oom();
  zs.next_in = data->data;
  zs.avail_in = (uInt)data->len;
  size_t len = 0;
  for (;;) {
    zs.next_out = buf + len;
    zs.avail_out = (uInt)(cap - len);
    int rc = inflate(&zs, Z_NO_FLUSH);
    len = cap - zs.avail_out;
    if (rc == Z_STREAM_END) break;
    if (rc == Z_OK || rc == Z_BUF_ERROR) {
      if (rc == Z_BUF_ERROR && zs.avail_in == 0 && zs.avail_out > 0) {
        /* Truncated input: Node throws "unexpected end of file". */
        inflateEnd(&zs);
        free(buf);
        static const char msg[] = "unexpected end of file";
        scr_throw_error_msg(SCR_ERR_ERROR, msg, sizeof msg - 1);
        return NULL;
      }
      if (cap - len < 64) {
        cap *= 2;
        uint8_t *grown = realloc(buf, cap);
        if (!grown) scr_zlib_oom();
        buf = grown;
      }
      continue;
    }
    /* Corrupt data: zlib's msg is exactly Node's error message text. */
    const char *msg = zs.msg ? zs.msg : "zlib error";
    size_t mlen = strlen(msg);
    inflateEnd(&zs);
    free(buf);
    scr_throw_error_msg(SCR_ERR_ERROR, msg, mlen);
    return NULL;
  }
  inflateEnd(&zs);
  ScrBytes *out = scr_bytes_new(SCR_BYTES_U8, (double)len);
  memcpy(out->data, buf, len);
  free(buf);
  return out;
}

static int scr_zlib_window_bits(int mode, bool inflating) {
  switch (mode) {
  case 1: return -15;
  case 2: return 15 + 16;
  case 3: return inflating ? 15 + 32 : 15;
  default: return 15;
  }
}

ScrBytes *scr_zlib_deflate_mode(const ScrBytes *data, double mode, double level) {
  SCR_BYTES_SNAPSHOT(data);
  z_stream zs;
  memset(&zs, 0, sizeof zs);
  int lvl = (int)level;
  if (lvl < -1 || lvl > 9) lvl = Z_DEFAULT_COMPRESSION;
  if (deflateInit2(&zs, lvl, Z_DEFLATED, scr_zlib_window_bits((int)mode, false), 8,
                   Z_DEFAULT_STRATEGY) != Z_OK) {
    scr_zlib_oom();
  }
  uLong cap = deflateBound(&zs, (uLong)data->len);
  uint8_t *buf = malloc(cap ? cap : 1);
  if (!buf) scr_zlib_oom();
  zs.next_in = data->data;
  zs.avail_in = (uInt)data->len;
  zs.next_out = buf;
  zs.avail_out = (uInt)cap;
  int rc = deflate(&zs, Z_FINISH);
  if (rc != Z_STREAM_END) scr_zlib_oom(); /* bound guarantees completion */
  size_t len = cap - zs.avail_out;
  deflateEnd(&zs);
  ScrBytes *out = scr_bytes_new(SCR_BYTES_U8, (double)len);
  memcpy(out->data, buf, len);
  free(buf);
  return out;
}

ScrBytes *scr_zlib_inflate_mode(const ScrBytes *data, double mode) {
  SCR_BYTES_SNAPSHOT(data);
  z_stream zs;
  memset(&zs, 0, sizeof zs);
  if (inflateInit2(&zs, scr_zlib_window_bits((int)mode, true)) != Z_OK) scr_zlib_oom();
  size_t cap = data->len > 64 ? data->len * 4 : 256;
  uint8_t *buf = malloc(cap);
  if (!buf) scr_zlib_oom();
  zs.next_in = data->data;
  zs.avail_in = (uInt)data->len;
  size_t len = 0;
  for (;;) {
    zs.next_out = buf + len;
    zs.avail_out = (uInt)(cap - len);
    int rc = inflate(&zs, Z_NO_FLUSH);
    len = cap - zs.avail_out;
    if (rc == Z_STREAM_END) break;
    if (rc == Z_OK || rc == Z_BUF_ERROR) {
      if (rc == Z_BUF_ERROR && zs.avail_in == 0 && zs.avail_out > 0) {
        inflateEnd(&zs);
        free(buf);
        static const char msg[] = "unexpected end of file";
        scr_throw_error_msg_code(SCR_ERR_ERROR, msg, sizeof msg - 1, "Z_BUF_ERROR");
        return NULL;
      }
      if (cap - len < 64) {
        cap *= 2;
        uint8_t *grown = realloc(buf, cap);
        if (!grown) scr_zlib_oom();
        buf = grown;
      }
      continue;
    }
    const char *msg = zs.msg ? zs.msg : "zlib error";
    size_t mlen = strlen(msg);
    /* Node stamps the zlib return code's name (err.code) */
    const char *code = rc == Z_DATA_ERROR ? "Z_DATA_ERROR"
                       : rc == Z_NEED_DICT ? "Z_NEED_DICT"
                       : rc == Z_MEM_ERROR ? "Z_MEM_ERROR"
                                           : "Z_STREAM_ERROR";
    inflateEnd(&zs);
    free(buf);
    scr_throw_error_msg_code(SCR_ERR_ERROR, msg, mlen, code);
    return NULL;
  }
  inflateEnd(&zs);
  ScrBytes *out = scr_bytes_new(SCR_BYTES_U8, (double)len);
  memcpy(out->data, buf, len);
  free(buf);
  return out;
}

double scr_zlib_crc32(const ScrBytes *data, double value) {
  SCR_BYTES_SNAPSHOT(data);
  char recv[48], msg[160];
  scr_num_received(value, recv);
  if (!(isfinite(value) && trunc(value) == value)) {
    int len = snprintf(msg, sizeof msg,
                       "The value of \"value\" is out of range. It must be an integer. Received %s",
                       recv);
    scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)len, "ERR_OUT_OF_RANGE");
    return 0;
  }
  if (value < 0 || value > 4294967295.0) {
    int len = snprintf(msg, sizeof msg,
                       "The value of \"value\" is out of range. It must be >= 0 && <= 4294967295. Received %s",
                       recv);
    scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)len, "ERR_OUT_OF_RANGE");
    return 0;
  }
  return (double)(uint32_t)crc32_z((uLong)value, data->data, data->len);
}

/* The callback convenience methods share the executable's four-worker
 * pool with fs.rename. Only copied raw bytes and malloc-owned result state
 * cross threads; runtime RC, exceptions, Buffer/Error construction, and
 * callback execution stay on the main thread. */
#ifndef SCR_LIB
typedef struct {
  unsigned char *data;
  size_t len;
  int mode;
  bool compressing;
  unsigned char *result;
  size_t result_len;
  int error;
  char message[128];
  ScrClosure *cb;
  ScrZlibBytesFn fn;
} ScrZlibAsyncOp;

static const char *scr_zlib_error_code(int error) {
  switch (error) {
  case Z_BUF_ERROR: return "Z_BUF_ERROR";
  case Z_DATA_ERROR: return "Z_DATA_ERROR";
  case Z_NEED_DICT: return "Z_NEED_DICT";
  case Z_MEM_ERROR: return "Z_MEM_ERROR";
  default: return "Z_STREAM_ERROR";
  }
}

static void scr_zlib_async_deflate(ScrZlibAsyncOp *op) {
  z_stream zs;
  memset(&zs, 0, sizeof zs);
  if (deflateInit2(&zs, Z_DEFAULT_COMPRESSION, Z_DEFLATED,
                   scr_zlib_window_bits(op->mode, false), 8,
                   Z_DEFAULT_STRATEGY) != Z_OK) {
    scr_zlib_oom();
  }
  uLong cap = deflateBound(&zs, (uLong)op->len);
  op->result = malloc(cap ? cap : 1);
  if (!op->result) scr_zlib_oom();
  zs.next_in = op->data;
  zs.avail_in = (uInt)op->len;
  zs.next_out = op->result;
  zs.avail_out = (uInt)cap;
  int rc = deflate(&zs, Z_FINISH);
  if (rc != Z_STREAM_END) scr_zlib_oom();
  op->result_len = cap - zs.avail_out;
  deflateEnd(&zs);
}

static void scr_zlib_async_inflate(ScrZlibAsyncOp *op) {
  z_stream zs;
  memset(&zs, 0, sizeof zs);
  if (inflateInit2(&zs, scr_zlib_window_bits(op->mode, true)) != Z_OK) {
    scr_zlib_oom();
  }
  size_t cap = op->len > 64 ? op->len * 4 : 256;
  op->result = malloc(cap);
  if (!op->result) scr_zlib_oom();
  zs.next_in = op->data;
  zs.avail_in = (uInt)op->len;
  size_t len = 0;
  for (;;) {
    zs.next_out = op->result + len;
    zs.avail_out = (uInt)(cap - len);
    int rc = inflate(&zs, Z_NO_FLUSH);
    len = cap - zs.avail_out;
    if (rc == Z_STREAM_END) {
      op->result_len = len;
      break;
    }
    if (rc == Z_OK || rc == Z_BUF_ERROR) {
      if (rc == Z_BUF_ERROR && zs.avail_in == 0 && zs.avail_out > 0) {
        op->error = Z_BUF_ERROR;
        memcpy(op->message, "unexpected end of file", sizeof "unexpected end of file");
        break;
      }
      if (cap - len < 64) {
        cap *= 2;
        unsigned char *grown = realloc(op->result, cap);
        if (!grown) scr_zlib_oom();
        op->result = grown;
      }
      continue;
    }
    op->error = rc;
    snprintf(op->message, sizeof op->message, "%s", zs.msg ? zs.msg : "zlib error");
    break;
  }
  inflateEnd(&zs);
}

static void scr_zlib_async_work(void *payload) {
  ScrZlibAsyncOp *op = payload;
  if (op->compressing) scr_zlib_async_deflate(op);
  else scr_zlib_async_inflate(op);
}

static void scr_zlib_async_after(void *payload) {
  ScrZlibAsyncOp *op = payload;
  if (op->error == Z_OK) {
    ScrBytes *value = scr_bytes_new(SCR_BYTES_U8, (double)op->result_len);
    memcpy(value->data, op->result, op->result_len);
    op->fn(op->cb, NULL, value);
    return;
  }
  scr_throw_error_msg_code(SCR_ERR_ERROR, op->message, strlen(op->message),
                           scr_zlib_error_code(op->error));
  ScrCaught *caught = scr_exc_take();
  ScrError *error = caught && caught->kind == SCR_EXC_OBJ && scr_error_is(caught->payload)
      ? (ScrError *)caught->payload
      : NULL;
  op->fn(op->cb, error, NULL);
  scr_caught_release(caught);
}

static void scr_zlib_async_destroy(void *payload) {
  ScrZlibAsyncOp *op = payload;
  free(op->data);
  free(op->result);
  scr_closure_release(op->cb);
  free(op);
}

void scr_zlib_codec_async(const ScrBytes *data, double mode, bool compressing,
                          ScrClosure *cb, ScrZlibBytesFn fn) {
  SCR_BYTES_SNAPSHOT(data);
  ScrZlibAsyncOp *op = calloc(1, sizeof *op);
  if (!op) scr_zlib_oom();
  op->data = malloc(data->len ? data->len : 1);
  if (!op->data) scr_zlib_oom();
  memcpy(op->data, data->data, data->len);
  op->len = data->len;
  op->mode = (int)mode;
  op->compressing = compressing;
  op->cb = cb;
  op->fn = fn;
  scr_work_submit(op, &scr_zlib_async_work, &scr_zlib_async_after,
                  &scr_zlib_async_destroy);
}
#endif

bool scr_zlib_inflate_exact(const unsigned char *src, size_t src_len,
                            unsigned char *dst, size_t dst_len) {
  z_stream zs;
  memset(&zs, 0, sizeof zs);
  if (inflateInit2(&zs, -15) != Z_OK) return false; /* raw DEFLATE */
  zs.next_in = (Bytef *)(uintptr_t)src;
  zs.avail_in = (uInt)src_len;
  zs.next_out = dst;
  zs.avail_out = (uInt)dst_len;
  int rc = inflate(&zs, Z_FINISH);
  bool ok = rc == Z_STREAM_END && zs.total_out == dst_len;
  inflateEnd(&zs);
  return ok;
}

/* ── the stream engine (Node's ZlibContext, node_zlib.cc) ───────────────
 * One z_stream per zlib.Gzip/Deflate/... instance. scr_zlib_stream.c owns
 * the Transform side and submits every write step to the worker pool;
 * scr_zlib_engine_work runs on the worker and touches only the z_stream.
 * Modes are Node's node_zlib_mode numbers (DEFLATE 1 ... UNZIP 7). */
struct ScrZlibEngine {
  z_stream strm;
  int mode;
  int level, window_bits, mem_level, strategy;
  int flush;
  int err;
  int gzip_id_bytes_read;
  bool init_done;
  bool reject_garbage;
  unsigned char *dict;
  size_t dict_len;
};

enum { SCR_Z_DEFLATE = 1, SCR_Z_INFLATE, SCR_Z_GZIP, SCR_Z_GUNZIP, SCR_Z_DEFLATERAW,
       SCR_Z_INFLATERAW, SCR_Z_UNZIP };

ScrZlibEngine *scr_zlib_engine_new(int mode, int level, int window_bits, int mem_level,
                                   int strategy, const unsigned char *dict, size_t dict_len,
                                   bool reject_garbage) {
  ScrZlibEngine *e = calloc(1, sizeof *e);
  if (!e) scr_zlib_oom();
  e->mode = mode;
  e->level = level;
  e->mem_level = mem_level;
  e->strategy = strategy;
  e->reject_garbage = reject_garbage;
  e->flush = Z_NO_FLUSH;
  e->err = Z_OK;
  e->window_bits = window_bits;
  if (mode == SCR_Z_GZIP || mode == SCR_Z_GUNZIP) e->window_bits += 16;
  if (mode == SCR_Z_UNZIP) e->window_bits += 32;
  if (mode == SCR_Z_DEFLATERAW || mode == SCR_Z_INFLATERAW) e->window_bits *= -1;
  if (dict && dict_len > 0) {
    e->dict = malloc(dict_len);
    if (!e->dict) scr_zlib_oom();
    memcpy(e->dict, dict, dict_len);
    e->dict_len = dict_len;
  }
  return e;
}

static bool scr_zlib_engine_deflating(const ScrZlibEngine *e) {
  return e->mode == SCR_Z_DEFLATE || e->mode == SCR_Z_GZIP || e->mode == SCR_Z_DEFLATERAW;
}

/* SetDictionary: deflate modes and raw inflate load it up front; the
 * other inflate modes load it when inflate() asks (Z_NEED_DICT). */
static bool scr_zlib_engine_set_dict(ScrZlibEngine *e) {
  if (!e->dict) return true;
  e->err = Z_OK;
  if (e->mode == SCR_Z_DEFLATE || e->mode == SCR_Z_DEFLATERAW) {
    e->err = deflateSetDictionary(&e->strm, e->dict, (uInt)e->dict_len);
  } else if (e->mode == SCR_Z_INFLATERAW) {
    e->err = inflateSetDictionary(&e->strm, e->dict, (uInt)e->dict_len);
  }
  return e->err == Z_OK;
}

/* InitZlib: lazy, on the first step. True when this call initialized. */
static bool scr_zlib_engine_init(ScrZlibEngine *e) {
  if (e->init_done) return false;
  e->strm.msg = NULL;
  if (scr_zlib_engine_deflating(e)) {
    e->err = deflateInit2(&e->strm, e->level, Z_DEFLATED, e->window_bits, e->mem_level,
                          e->strategy);
  } else {
    e->err = inflateInit2(&e->strm, e->window_bits);
  }
  if (e->err != Z_OK) {
    free(e->dict);
    e->dict = NULL;
    e->dict_len = 0;
    e->mode = 0;
    return true;
  }
  scr_zlib_engine_set_dict(e);
  e->init_done = true;
  return true;
}

static int scr_zlib_engine_reset_stream(ScrZlibEngine *e) {
  if (scr_zlib_engine_init(e) && e->err != Z_OK) return 1;
  e->err = Z_OK;
  switch (e->mode) {
  case SCR_Z_DEFLATE:
  case SCR_Z_DEFLATERAW:
  case SCR_Z_GZIP: e->err = deflateReset(&e->strm); break;
  case SCR_Z_INFLATE:
  case SCR_Z_INFLATERAW:
  case SCR_Z_GUNZIP: e->err = inflateReset(&e->strm); break;
  default: break;
  }
  if (e->err != Z_OK) return 2;
  return scr_zlib_engine_set_dict(e) ? 0 : 3;
}

void scr_zlib_engine_work(ScrZlibEngine *e, int flush, const unsigned char *in, uint32_t in_len,
                          unsigned char *out, uint32_t out_len) {
  e->strm.avail_in = in_len;
  e->strm.next_in = (Bytef *)(uintptr_t)in;
  e->strm.avail_out = out_len;
  e->strm.next_out = out;
  e->flush = flush;
  if (scr_zlib_engine_init(e) && e->err != Z_OK) return;
  switch (e->mode) {
  case SCR_Z_DEFLATE:
  case SCR_Z_GZIP:
  case SCR_Z_DEFLATERAW:
    e->err = deflate(&e->strm, flush);
    return;
  case SCR_Z_UNZIP: {
    /* The gzip magic decides GUNZIP vs INFLATE, possibly across steps. */
    const Bytef *next = e->strm.avail_in > 0 ? e->strm.next_in : NULL;
    if (e->gzip_id_bytes_read == 0 && next != NULL) {
      if (*next == 0x1f) {
        e->gzip_id_bytes_read = 1;
        next++;
        if (e->strm.avail_in == 1) next = NULL;
      } else {
        e->mode = SCR_Z_INFLATE;
        next = NULL;
      }
    }
    if (e->gzip_id_bytes_read == 1 && next != NULL && e->mode == SCR_Z_UNZIP) {
      if (*next == 0x8b) {
        e->gzip_id_bytes_read = 2;
        e->mode = SCR_Z_GUNZIP;
      } else {
        e->mode = SCR_Z_INFLATE;
      }
    }
  }
  /* fallthrough */
  case SCR_Z_INFLATE:
  case SCR_Z_GUNZIP:
  case SCR_Z_INFLATERAW:
    e->err = inflate(&e->strm, flush);
    if (e->mode != SCR_Z_INFLATERAW && e->err == Z_NEED_DICT && e->dict) {
      e->err = inflateSetDictionary(&e->strm, e->dict, (uInt)e->dict_len);
      if (e->err == Z_OK) e->err = inflate(&e->strm, flush);
      else if (e->err == Z_DATA_ERROR) e->err = Z_NEED_DICT;
    }
    /* Another gzip member may follow; trailing zero bytes are padding. */
    while (e->strm.avail_in > 0 && e->mode == SCR_Z_GUNZIP && e->err == Z_STREAM_END &&
           !e->reject_garbage && e->strm.next_in[0] != 0x00) {
      scr_zlib_engine_reset_stream(e);
      e->err = inflate(&e->strm, flush);
    }
    return;
  default:
    return;
  }
}

void scr_zlib_engine_offsets(const ScrZlibEngine *e, uint32_t *avail_in, uint32_t *avail_out) {
  *avail_in = e->strm.avail_in;
  *avail_out = e->strm.avail_out;
}

static const char *scr_zlib_strerror(int err) {
  switch (err) {
  case Z_OK: return "Z_OK";
  case Z_STREAM_END: return "Z_STREAM_END";
  case Z_NEED_DICT: return "Z_NEED_DICT";
  case Z_ERRNO: return "Z_ERRNO";
  case Z_STREAM_ERROR: return "Z_STREAM_ERROR";
  case Z_DATA_ERROR: return "Z_DATA_ERROR";
  case Z_MEM_ERROR: return "Z_MEM_ERROR";
  case Z_BUF_ERROR: return "Z_BUF_ERROR";
  case Z_VERSION_ERROR: return "Z_VERSION_ERROR";
  default: return "Z_UNKNOWN_ERROR";
  }
}

static bool scr_zlib_engine_fail(const ScrZlibEngine *e, const char *message, ScrZlibError *out) {
  out->message = e->strm.msg ? e->strm.msg : message;
  out->code = scr_zlib_strerror(e->err);
  out->err = e->err;
  return true;
}

bool scr_zlib_engine_error(const ScrZlibEngine *e, ScrZlibError *out) {
  switch (e->err) {
  case Z_OK:
  case Z_BUF_ERROR:
    if (e->strm.avail_out != 0 && e->flush == Z_FINISH)
      return scr_zlib_engine_fail(e, "unexpected end of file", out);
    return false;
  case Z_STREAM_END: return false;
  case Z_NEED_DICT:
    return scr_zlib_engine_fail(e, e->dict ? "Bad dictionary" : "Missing dictionary", out);
  default: return scr_zlib_engine_fail(e, "Zlib error", out);
  }
}

bool scr_zlib_engine_reset(ScrZlibEngine *e, ScrZlibError *out) {
  switch (scr_zlib_engine_reset_stream(e)) {
  case 0: return false;
  case 1: return scr_zlib_engine_fail(e, "Failed to init stream before reset", out);
  case 2: return scr_zlib_engine_fail(e, "Failed to reset stream", out);
  default: return scr_zlib_engine_fail(e, "Failed to set dictionary", out);
  }
}

/* SetParams: deflateParams for DEFLATE and DEFLATERAW only (Node's
 * switch leaves GZIP's level and strategy unchanged). */
bool scr_zlib_engine_params(ScrZlibEngine *e, int level, int strategy, ScrZlibError *out) {
  if (scr_zlib_engine_init(e) && e->err != Z_OK)
    return scr_zlib_engine_fail(e, "Failed to init stream before set parameters", out);
  e->err = Z_OK;
  if (e->mode == SCR_Z_DEFLATE || e->mode == SCR_Z_DEFLATERAW)
    e->err = deflateParams(&e->strm, level, strategy);
  if (e->err != Z_OK && e->err != Z_BUF_ERROR)
    return scr_zlib_engine_fail(e, "Failed to set parameters", out);
  return false;
}

void scr_zlib_engine_free(ScrZlibEngine *e) {
  if (!e) return;
  if (e->init_done) {
    if (scr_zlib_engine_deflating(e)) deflateEnd(&e->strm);
    else inflateEnd(&e->strm);
  }
  free(e->dict);
  free(e);
}

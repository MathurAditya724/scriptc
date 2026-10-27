/* Private function-body template, intentionally without an include guard.
 * The caller provides validated fd, buf, off, want and position locals, and
 * this body returns the read count. position may be double or int64_t.
 * Including it at the original Number body location preserves that path's
 * code and error-helper emission while sharing all read/error handling. */
  uint8_t *bounce = buf->shared ? malloc(want ? want : 1) : NULL;
  if (buf->shared && !bounce) scr_trap("scriptc: out of memory\n");
  uint8_t *destination = bounce ? bounce : buf->data + off;
  ssize_t n = position == -1
    ? read((int)fd, destination, want)
    : scr_fs_pread((int)fd, destination, want, position);
  int read_error = errno;
  if (bounce) {
    if (n > 0) scr_bytes_write(buf, off, bounce, (size_t)n);
    free(bounce);
  }
  errno = read_error;
  if (n < 0) {
    int e = errno;
    char namebuf[16];
    const char *name = scr_errno_name(e, namebuf, sizeof namebuf);
    const char *text = scr_errno_text(e);
    char msg[160];
    int len = snprintf(msg, sizeof msg, "%s: %s, read", name, text);
    scr_fs_throw_details(e, name, msg, (size_t)len, "read", NULL, NULL);
    return 0;
  }
  return (double)n;

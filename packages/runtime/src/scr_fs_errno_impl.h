/* Private fs errno names and texts, shared by the Number and BigInt reads.
 * Include after the runtime and errno/system headers. */
#ifndef SCR_FS_ERRNO_IMPL_H
#define SCR_FS_ERRNO_IMPL_H

static const char *scr_errno_name(int e, char *fallback, size_t cap) {
  switch (e) {
  case ENOENT: return "ENOENT";
  case EEXIST: return "EEXIST";
  case EACCES: return "EACCES";
  case EBUSY: return "EBUSY";
  case EINVAL: return "EINVAL";
  case EIO: return "EIO";
  case ENAMETOOLONG: return "ENAMETOOLONG";
  case ENOMEM: return "ENOMEM";
  case ENOSPC: return "ENOSPC";
  case ENOTDIR: return "ENOTDIR";
  case EISDIR: return "EISDIR";
  case ENOTEMPTY: return "ENOTEMPTY";
  case EPERM: return "EPERM";
  case EROFS: return "EROFS";
  case EXDEV: return "EXDEV";
  case EBADF: return "EBADF";
  case EAGAIN: return "EAGAIN";
  case EFBIG: return "EFBIG";
  case EPIPE: return "EPIPE";
  case ESPIPE: return "ESPIPE";
  case ELOOP: return "ELOOP";
  case ENOSYS: return "ENOSYS";
  case ENOTSUP: return "ENOTSUP";
  default:
    snprintf(fallback, cap, "E%d", e);
    return fallback;
  }
}

static const char *scr_errno_text(int e) {
  switch (e) {
  case ENOENT: return "no such file or directory";
  case EEXIST: return "file already exists";
  case EACCES: return "permission denied";
  case EBUSY: return "resource busy or locked";
  case EINVAL: return "invalid argument";
  case EIO: return "i/o error";
  case ENAMETOOLONG: return "name too long";
  case ENOMEM: return "not enough memory";
  case ENOSPC: return "no space left on device";
  case ENOTDIR: return "not a directory";
  case EISDIR: return "illegal operation on a directory";
  case ENOTEMPTY: return "directory not empty";
  case EPERM: return "operation not permitted";
  case EROFS: return "read-only file system";
  case EXDEV: return "cross-device link not permitted";
  case EBADF: return "bad file descriptor";
  case EAGAIN: return "resource temporarily unavailable";
  case EFBIG: return "file too large";
  case EPIPE: return "broken pipe";
  case ESPIPE: return "invalid seek";
  case ELOOP: return "too many levels of symbolic links";
  case ENOSYS: return "function not implemented";
  default: return strerror(e);
  }
}

#endif /* SCR_FS_ERRNO_IMPL_H */

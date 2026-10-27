/* Private positioned-read implementation. The caller defines
 * SCR_FS_READ_POSITION as double for the existing Number path or int64_t
 * for validated BigInt positions; the Windows and POSIX logic stays shared. */
#ifndef SCR_FS_PREAD_IMPL_H
#define SCR_FS_PREAD_IMPL_H

static ssize_t scr_fs_pread(int fd, void *data, size_t length, SCR_FS_READ_POSITION position) {
#ifdef _WIN32
  HANDLE handle = (HANDLE)_get_osfhandle(fd);
  if (handle == INVALID_HANDLE_VALUE) {
    errno = EBADF;
    return -1;
  }

  OVERLAPPED overlapped;
  memset(&overlapped, 0, sizeof overlapped);
  LARGE_INTEGER at;
  at.QuadPart = (LONGLONG)position;
  overlapped.Offset = at.LowPart;
  overlapped.OffsetHigh = at.HighPart;

  LARGE_INTEGER zero;
  LARGE_INTEGER original;
  zero.QuadPart = 0;
  BOOL restore = SetFilePointerEx(handle, zero, &original, FILE_CURRENT);
  DWORD got = 0;
  DWORD want = length > (size_t)UINT32_MAX ? UINT32_MAX : (DWORD)length;
  BOOL ok = ReadFile(handle, data, want, &got, &overlapped);
  DWORD error = ok ? ERROR_SUCCESS : GetLastError();
  if (restore) (void)SetFilePointerEx(handle, original, NULL, FILE_BEGIN);
  /* ReadFile may report a terminal status after still filling part of the
   * caller's buffer (notably ERROR_MORE_DATA for a message-mode pipe).
   * libuv/Node return those bytes and surface the status on the next read. */
  if (ok || got > 0 || error == ERROR_HANDLE_EOF || error == ERROR_BROKEN_PIPE) {
    return (ssize_t)got;
  }

  /* The read-specific subset of libuv's Win32-to-errno translation. */
  switch (error) {
    case ERROR_INVALID_HANDLE:
    case ERROR_ACCESS_DENIED:
      errno = EBADF;
      break;
    case ERROR_INVALID_FUNCTION:
    case ERROR_INVALID_PARAMETER:
      errno = EINVAL;
      break;
    case ERROR_NOT_ENOUGH_MEMORY:
    case ERROR_OUTOFMEMORY:
      errno = ENOMEM;
      break;
    case ERROR_OPERATION_ABORTED:
      errno = EINTR;
      break;
    default:
      errno = EIO;
      break;
  }
  return -1;
#else
  return pread(fd, data, length, (off_t)position);
#endif
}

#endif /* SCR_FS_PREAD_IMPL_H */

/* A deterministic process oracle. It accepts the real server's arguments,
 * but its small modes isolate OS transport behavior from TypeScript RPC. */
#ifndef _WIN32
#define _POSIX_C_SOURCE 200809L
#endif
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#include <windows.h>
#else
#include <unistd.h>
#endif

static int child_main(int argc, char **argv) {
#ifdef _WIN32
  _setmode(_fileno(stdin), _O_BINARY);
  _setmode(_fileno(stdout), _O_BINARY);
#endif
  if (argc < 5 || argc > 6 || strcmp(argv[1], "--api") != 0 || strcmp(argv[2], "--cwd") != 0 ||
      strncmp(argv[4], "--callbacks=", 12) != 0 || (argc == 6 && strcmp(argv[5], "--timing") != 0)) return 71;
  const char *mode = argv[3];
  if (strncmp(mode, "argv:", 5) == 0) {
    fwrite(mode + 5, 1, strlen(mode + 5), stdout);
    fputc('\n', stdout);
    fputs(argv[4], stdout);
    fputc('\n', stdout);
    fputs(argc == 6 ? "timing\n" : "plain\n", stdout);
    return ferror(stdout) ? 72 : 0;
  }
  if (strcmp(mode, "exit") == 0) return 0;
  if (strcmp(mode, "stderr") == 0) {
    fputs("native server stderr\n", stderr);
    return 0;
  }
  if (strcmp(mode, "stall") == 0) {
    // Tell the parent we started, then deliberately ignore closed input.
    fputc('!', stdout);
    fflush(stdout);
    for (;;) {
#ifdef _WIN32
      Sleep(1000);
#else
      sleep(1);
#endif
    }
  }
  if (strcmp(mode, "echo") != 0) return 73;
  // Unbuffered reads let short writes make progress without waiting for a
  // complete stdio buffer. Fragment each echoed reply independently.
  uint8_t bytes[17];
  for (;;) {
#ifdef _WIN32
    int count = _read(_fileno(stdin), bytes, sizeof(bytes));
#else
    ssize_t count = read(STDIN_FILENO, bytes, sizeof(bytes));
#endif
    if (count <= 0) return count < 0 ? 74 : 0;
    if (fwrite(bytes, 1, (size_t)count, stdout) != (size_t)count || fflush(stdout) != 0) return 75;
  }
}

#ifdef _WIN32
// Go's executable reads Unicode argv directly. Use the same contract here
// instead of the active ANSI code page of an ordinary CRT main().
int wmain(int argc, wchar_t **wide) {
  char **argv = calloc((size_t)argc, sizeof(*argv));
  if (argv == NULL) return 76;
  for (int i = 0; i < argc; i++) {
    int size = WideCharToMultiByte(CP_UTF8, 0, wide[i], -1, NULL, 0, NULL, NULL);
    argv[i] = malloc((size_t)size);
    if (argv[i] == NULL) return 76;
    WideCharToMultiByte(CP_UTF8, 0, wide[i], -1, argv[i], size, NULL, NULL);
  }
  int result = child_main(argc, argv);
  for (int i = 0; i < argc; i++) free(argv[i]);
  free(argv);
  return result;
}
#else
int main(int argc, char **argv) { return child_main(argc, argv); }
#endif

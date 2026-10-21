/* scriptc runtime — the C ABI between the runtime and the libnode bridge
 * (packages/libnode-common/bridge/scr_node_bridge.cc). The runtime never
 * includes a Node or V8 header: it loads the bridge library of a libnode
 * pack with dlopen on first use and talks to it only through this table.
 * The bridge links libnode and pins the Node ABI; the runtime pins only
 * SCR_NODE_BRIDGE_ABI, which changes with any change to these structs.
 *
 * Conventions: strings are UTF-8 and borrowed unless noted. Call outcomes
 * are "R<json>" (returned; "R" alone is undefined) or "T<json>" (threw;
 * the JSON is {"error":{kind,message,code?}}, {"value":...} or
 * {"undefined":true}, see scr_node_island_host.cjs). Every entry point
 * runs on the thread that called start. */
#ifndef SCR_NODE_BRIDGE_H
#define SCR_NODE_BRIDGE_H

#include <stddef.h>
#include <stdint.h>

#define SCR_NODE_BRIDGE_ABI 1u
/* The symbol a bridge library exports: `const ScrNodeBridge *(void)`. */
#define SCR_NODE_BRIDGE_ENTRY "scr_node_bridge_v1"

/* What the runtime provides to the bridge. */
typedef struct ScrNodeBridgeHost {
  /* An asynchronous call settled with this outcome. */
  void (*settle)(uint32_t id, const char *outcome, size_t len);
  /* Node ends the process (process.exit, an uncaught exception): the
   * runtime runs its exit sequence with this code and never returns. */
  void (*exit)(int code);
} ScrNodeBridgeHost;

typedef struct ScrNodeBridge {
  uint32_t abi;               /* SCR_NODE_BRIDGE_ABI */
  const char *node_version;   /* the libnode it links: "24.22.0" */
  uint32_t module_version;    /* its NODE_MODULE_VERSION */
  /* Initializes Node once per process and runs `bootstrap` as the main
   * script of one environment. argv[0] names the executable. Returns NULL,
   * or a message the runtime frees with `release`. */
  char *(*start)(const ScrNodeBridgeHost *host, const char *bootstrap, const char *argv0);
  /* Calls the bootstrap's dispatcher in a callback scope (ticks and
   * microtasks drain when it closes, as after any libuv callback). A
   * synchronous call answers its outcome (+1, freed with `release`, length
   * in *len); an asynchronous one answers NULL and settles through the
   * host, possibly before it returns. */
  char *(*call)(uint32_t id, int sync, const char *file, const char *specifier,
                const char *name, const char *args, size_t args_len, size_t *len);
  void (*release)(void *memory);
  /* Node's event loop, driven from the runtime's loop until NI-3 hosts the
   * runtime's queues on it: a pollable backend fd, the timeout to its next
   * timer (-1: none), whether ref'd work remains, and one non-blocking
   * turn (libuv callbacks plus platform tasks). */
  int (*backend_fd)(void);
  int (*backend_timeout)(void);
  int (*alive)(void);
  void (*pump)(void);
  /* Tears Node down at process exit. */
  void (*stop)(void);
} ScrNodeBridge;

#endif /* SCR_NODE_BRIDGE_H */

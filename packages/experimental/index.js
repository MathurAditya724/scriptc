// @scriptc/experimental — the Node.js implementation.
//
// scriptc builds lower these exports to compiler intrinsics. Under Node.js
// a LifetimeRegion is an ordinary object: run() calls its callback and
// release() does nothing, since the garbage collector reclaims what the
// program no longer references.

export class LifetimeRegion {
  /** Calls `fn` and returns its result. */
  run(fn) {
    return fn();
  }

  /** Does nothing under Node.js. */
  release() {}
}

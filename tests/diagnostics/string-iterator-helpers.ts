// The string iterator has no iterator-helper lowering; the call is
// refused instead of failing at run time.
const upper = "abc"[Symbol.iterator]().map((c) => c.toUpperCase());

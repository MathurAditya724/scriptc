"use strict";
// A bundled class keeps esbuild's `var X = class` spelling.
var Counter = class {
  constructor(start) {
    this.n = start;
  }
  next() {
    return ++this.n;
  }
};
module.exports = Counter;

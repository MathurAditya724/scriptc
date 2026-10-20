"use strict";
let Gate = class {
  constructor(limit) {
    this.limit = limit;
    this.open = 0;
  }
  enter() {
    if (this.open === this.limit) return false;
    this.open++;
    return true;
  }
};
module.exports = { Gate };

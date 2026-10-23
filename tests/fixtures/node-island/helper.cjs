"use strict";
exports.answer = () => 42;
exports.echo = (value) => value;
// An error whose message cannot be read.
exports.unreadable = () => {
  const error = new Error();
  Object.defineProperty(error, "message", {
    get() {
      throw Symbol("message");
    },
  });
  throw error;
};

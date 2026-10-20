"use strict";
// esbuild hoists a bundled module's top-level const to a var like this.
var toText = function (input) {
  return "text:" + input;
};
toText.object = function (input) {
  return { value: input };
};
module.exports = toText;

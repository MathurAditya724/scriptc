// Functions whose `arguments` is unmapped (a default parameter, or strict
// code) and is used as a value, exported for another module.
function show(a = 1) {
  const args = arguments;
  return args.length + ":" + args[0];
}
exports.show = show;
module.exports.count = function (b = 2) {
  const all = arguments;
  return all.length;
};
exports.strict = function (c) {
  "use strict";
  const all = arguments;
  return all.length + ":" + c;
};

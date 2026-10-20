"use strict";
function format(value) {
  return "[" + value + "]";
}
function shout(value) {
  return String(value).toUpperCase();
}
module.exports = format;
module.exports.shout = shout;
module.exports.version = "1.2.3";

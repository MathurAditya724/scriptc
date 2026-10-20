"use strict";
function quote(value) {
  return '"' + value + '"';
}
function whisper(value) {
  return String(value).toLowerCase();
}
exports = module.exports = quote;
exports.whisper = whisper;
exports.kind = "quote";

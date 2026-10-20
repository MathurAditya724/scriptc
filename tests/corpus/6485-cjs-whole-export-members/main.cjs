// A module whose whole export is a function and which attaches members to
// it (`module.exports = format; module.exports.shout = shout`, with or
// without rebinding `exports`): requirers read and call the members
// through the function, as Node attaches them to it.
"use strict";
const format = require("./plain.cjs");
const quote = require("./rebound.cjs");
console.log(format("a"), format.shout("b"), format.version, typeof format.shout);
console.log(quote("c"), quote.whisper("D"), quote.kind, typeof quote.whisper);
const { shout } = require("./plain.cjs");
console.log(shout === format.shout);

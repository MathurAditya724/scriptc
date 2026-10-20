// A module exporting classes through object-literal shorthand
// (`module.exports = { Channel, Plain }`), one of them extending
// EventEmitter; the importer constructs, compares and tests instances
// through the exported values.
const { EventEmitter } = require("node:events");
const lib = require("./channel.cjs");
const { Channel, Plain } = lib;

const ch = new lib.Channel("alpha");
ch.on("message", (message, from) => console.log("message", message, from));
ch.send("hello");
console.log(lib.Channel.name, Channel === lib.Channel, ch instanceof Channel, ch instanceof EventEmitter);
const p = new Plain();
console.log(p.kind, p instanceof lib.Plain, lib.Plain.name, new lib.Plain() instanceof Plain);
console.log(ch.listenerCount("message"), ch.eventNames());

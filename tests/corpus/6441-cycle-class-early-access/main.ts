// A class of an import cycle reached before its module body ran: Node
// throws the temporal-dead-zone ReferenceError at the access, and the
// same class works once its module finished.
import { Sink } from "./log.ts";
import { early } from "./stats.ts";

console.log("early:", early);
console.log("late:", new Sink("late").tag);

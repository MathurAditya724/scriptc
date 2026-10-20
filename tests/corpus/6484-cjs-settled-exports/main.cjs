// A CommonJS export copies a variable's value at the export statement.
// When every write to the variable sits in top-level code above that
// statement (esbuild's hoisted var, a let settled by a loop), the copied
// value is the variable's final value, and the module compiles. That
// includes classes bound to a var or let, as bundles spell them.
"use strict";
const toText = require("./lib.cjs");
const table = require("./table.cjs");
const Counter = require("./class.cjs");
const { Gate } = require("./sema.cjs");
console.log(toText("a"), JSON.stringify(toText.object(2)));
console.log(table.label, table.total);
const counter = new Counter(1);
console.log(counter.next(), counter.next());
const gate = new Gate(1);
console.log(gate.enter(), gate.enter());

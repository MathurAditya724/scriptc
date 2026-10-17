// new RegExp with literal d or v flags refuses like the regex literal
// forms; computed flags reach the runtime, which names the same gap.
const sets = new RegExp("[\\w--\\d]", "v");
const indices = new RegExp("cat", "dg");

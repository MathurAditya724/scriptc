// %o passes its active showHidden flag to custom inspectors. Nested calls
// use their own defaults and restore the outer flag, including after throws.
const util = require("node:util");
const leaf = {
  [util.inspect.custom](depth, options) {
    return "leaf:" + options.showHidden;
  },
};
console.log(util.format("%O | %o | %O", leaf, leaf, leaf));
console.log(util.format("%o", { leaf }));
console.log(util.format("%o", [leaf]));

const nested = {
  [util.inspect.custom](depth, options) {
    return (
      "outer:" + options.showHidden +
      " default:" + util.inspect(leaf) +
      " hidden:" + util.format("%o", leaf) +
      " saved:" + options.showHidden
    );
  },
};
console.log(util.format("%o", { first: nested, last: leaf }));

const throwing = {
  [util.inspect.custom]() {
    throw new Error("from custom");
  },
};
const catches = {
  [util.inspect.custom](depth, options) {
    try {
      util.format("%o", throwing);
    } catch (error) {
      return "caught:" + error.message + ":" + options.showHidden + ":" + util.inspect(leaf);
    }
    return "not thrown";
  },
};
console.log(util.format("%o", { first: catches, last: leaf }));
try {
  util.format("%o", throwing);
} catch (error) {
  console.log("caught", error.message);
}
console.log(util.inspect(leaf));
console.log(util.format("%o | %O", leaf, leaf));

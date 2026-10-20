// A bundled CommonJS dependency exports a function binding as its whole
// module (`module.exports = toText2`, then members on it). esbuild hoists
// the dependency's top-level const to a `var` in its __commonJS chunk, so
// the export names a var that nothing reassigns after the export.
import { demo } from "gtvarexport";

console.log(demo(["a", "b"]));
console.log(demo([]));

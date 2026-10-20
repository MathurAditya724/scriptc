// A minified bundle merges a module's requires and the bindings read from
// them into one declaration (`var minimatch=require_x(),Minimatch=
// minimatch.Minimatch,…`, glob's shape). Each binding reads the module
// value the earlier declarator required.
import { demo } from "gtmergedreq";

console.log(demo("/x/y.js"));
console.log(demo("pattern"));

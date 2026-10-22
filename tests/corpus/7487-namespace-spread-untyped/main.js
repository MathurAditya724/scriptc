import * as shapes from "./shapes.js";
import * as extra from "./extra.js";
// A namespace spread into an untyped object (zod's local
// `const z = { ..._schemas, ..._checks, iso: _iso }`).
function untyped(value) {
  return value;
}
const z = untyped({ ...shapes, ...extra, extra });
console.log(Object.keys(z).join(","));
for (const key of ["circle", "square"]) console.log(key, z[key](2).area.toFixed(2));
console.log(z.VERSION, typeof z.extra.tag, z.extra.tag("x"), new z.Box(4).size);

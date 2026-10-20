// semver 6's load-time shape in a bundle: the module exports its
// constructor first (`exports = module.exports = Version`), then fills a
// token table that the hoisted constructor reads
// (`t=exports.tokens={}` ... `function tok(n){t[n]=R++}`). Nothing can
// call the constructor before the table exists, so the table is a plain
// module object.
import { demo } from "gtsemverbundle";

console.log(demo());

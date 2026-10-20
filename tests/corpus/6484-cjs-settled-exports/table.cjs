"use strict";
// Written only above the export, in top-level code.
let total = 0;
for (const n of [1, 2, 3]) total += n;
var label = "sum";
if (total > 5) label = "big sum";
module.exports = { total, label };

// util.inherits onto a runtime-provided class (stream.Readable, the from2
// and multistream shape in JavaScript) has no prototype object to link a
// constructor function's prototype to: the call fences where it is written
// instead of throwing Node's ERR_INVALID_ARG_TYPE at run time.
import { inherits } from "node:util";
import { Readable } from "node:stream";

function Source(): void {}
inherits(Source, Readable);
console.log(typeof Source);

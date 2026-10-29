// Classes reached through unknown use the same custom inspection options
// as untyped objects, with the flag restored between substitutions.
import { format, inspect, type InspectOptions } from "node:util";

class Leaf {
  [inspect.custom](_depth: number, options: InspectOptions): string {
    return "class:" + options.showHidden;
  }
}
const leaf: unknown = new Leaf();
console.log(format("%O | %o | %O", leaf, leaf, leaf));
console.log(format("%o", { leaf } as unknown));
console.log(inspect(leaf));

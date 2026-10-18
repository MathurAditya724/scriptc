// The same speculative element-type query, reaching a function-local class
// with a private brand through the function's returned array.
function make() {
  class Box {
    #v = 1;
    read(): number {
      return this.#v;
    }
  }
  return [new Box()];
}
const xs = make();
const x = xs[0];
console.log(x === undefined ? -1 : x.read());

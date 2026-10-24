// Array subclasses that do not compile yet, each refused where it is
// declared: a generic subclass, a subclass of a class that extends Array,
// and a class that declares its own Symbol.species.
class Bag<T> extends Array<T> {
  firstOr(fallback: T): T {
    return this.length > 0 ? this[0]! : fallback;
  }
}

class Base extends Array<number> {}
class Derived extends Base {}

class Speciated extends Array<number> {
  static get [Symbol.species](): ArrayConstructor {
    return Array;
  }
}

console.log(new Bag<number>().firstOr(1));
console.log(new Derived().length);
console.log(new Speciated().length);

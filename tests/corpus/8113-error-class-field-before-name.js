"use strict";
// Error subclasses with a class field, which their instances create before
// an own `name`, and a property bag that a later dynamic definition or
// write commits. Object.keys and JSON list the field before `name`, and a
// `message` that Error's constructor created before both.

const messageDescriptor = {
  get() {
    return "described";
  },
  enumerable: true,
  configurable: true,
};

// A factory-built class: the field, then an initializer that assigns `name`
// and defines `message`.
function factory(initializer) {
  class Definition extends Error {
    code = "E_FIELD";
  }
  return function construct() {
    const instance = new Definition();
    initializer(instance);
    return instance;
  };
}
const Fielded = factory((instance) => {
  instance.name = "Fielded";
  Object.defineProperty(instance, "message", messageDescriptor);
});
const fielded = new Fielded();
console.log(Object.keys(fielded).join(","), JSON.stringify(fielded));
fielded.extra = 1;
console.log(Object.keys(fielded).join(","), JSON.stringify(fielded));
fielded.name = "Renamed";
console.log(Object.keys(fielded).join(","), JSON.stringify(fielded), fielded.name);

// A class whose constructor passes a message to Error and then assigns
// `name`; the message is redefined after construction.
class Direct extends Error {
  code = "E_DIRECT";
  constructor() {
    super("constructed");
    this.name = "Direct";
  }
}
function redefine(instance) {
  Object.defineProperty(instance, "message", messageDescriptor);
  instance.extra = 2;
  return instance;
}
const direct = redefine(new Direct());
console.log(Object.keys(direct).join(","), JSON.stringify(direct), direct.name);

// Function-valued properties of class instances in a JavaScript program:
// methods assigned in the constructor, replaced later, and called through
// the instance read `this` for the instance they were called on.
'use strict';
class Greeter {
  constructor(name) {
    this.name = name;
    this.greet = function (other) {
      return `${this.name} greets ${other}`;
    };
    this.shout = (other) => `${other.toUpperCase()}!`;
  }
}
const g = new Greeter('ann');
const h = new Greeter('ben');
console.log(g.greet('you'), h.greet('me'), g.shout('hey'));
h.greet = g.greet;
console.log(h.greet('again'));
let calls = 0;
g.greet = function (other) {
  calls++;
  return `${this === g} ${this === h} ${other}`;
};
console.log(g.greet('x'), calls);

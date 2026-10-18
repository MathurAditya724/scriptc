// Node creates an UNMAPPED arguments object for strict code and for
// functions whose parameter list is not simple (defaults, patterns), even
// in a sloppy CommonJS module: a parameter write never shows through it.

function defaults(a, b = 'B') {
  a = 'changed';
  b = 'b changed';
  return [arguments[0], arguments[1], arguments.length, a, b];
}
console.log(defaults('a'));
console.log(defaults('a', 'b', 'c'));
console.log(defaults());

function destructured({ x }, y) {
  y = 'new y';
  return [arguments.length, arguments[1], y, x];
}
console.log(destructured({ x: 1 }, 'old y'));

function strictFunction(a, b) {
  'use strict';
  a = 'changed';
  return [arguments[0], arguments[1], a, b, arguments.length];
}
console.log(strictFunction('a', 'b'));
console.log(strictFunction());

function strictOuter() {
  'use strict';
  function inner(a) {
    a = 'changed';
    return [arguments[0], a];
  }
  return inner('original');
}
console.log(strictOuter());

class Holder {
  method() {
    // Functions nested in a class body are strict code too.
    var nested = function (a) { a = 2; return arguments[0]; };
    return nested(1);
  }
}
console.log(new Holder().method());

function copiedFirst(a) {
  'use strict';
  var seen = Array.prototype.slice.call(arguments);
  a = 'later';
  return seen.concat([arguments[0], a]);
}
console.log(copiedFirst('first', 'second'));

function forwarded(a, b = 0) {
  a = -1;
  return Array.from(arguments).concat([...arguments], [a, b]);
}
console.log(forwarded(1, 2, 3));

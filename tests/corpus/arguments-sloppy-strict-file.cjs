'use strict';
// A 'use strict' file prologue makes every function strict: arguments is
// unmapped, so parameter writes never show through it.

function update(a, b) {
  a = a * 2;
  b = 'b2';
  return [arguments[0], arguments[1], arguments.length, a, b];
}
console.log(update(1, 'b'));
console.log(update(3));

function counter(n) {
  var bump = () => { n++; return arguments[0]; };
  bump();
  bump();
  return [n, arguments[0], bump()];
}
console.log(counter(10));

const saved = update;
console.log(saved(5, 'x', 'extra'));

function spreadAfterWrite(a, b) {
  a = 'changed';
  return [...arguments].join(' ');
}
console.log(spreadAfterWrite('a', 'b', 'c'));

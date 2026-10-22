'use strict';
// Functions and classes reached as dynamic values print their enumerable
// own properties after the tag, as Node prints them: a class's static
// properties, properties assigned to a function, cycles through them,
// and `[Function]` past the depth limit.
const util = require('util');

function f() {}
f.x = 1;
f.label = 'f';
function g() {}
g.self = g;
function plain() {}
class A {}
class S extends A {
  static get hidden() {
    return 1;
  }
}
S.count = 3;
function show(value) {
  console.log(value);
}
show(f);
show(g);
show(S);
show(A);
show(plain);
function shallow(value) {
  console.log(util.inspect({ value }, { depth: 0 }));
}
shallow(f);
shallow(S);
shallow(A);

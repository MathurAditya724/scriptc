// Sloppy-mode functions with simple parameter lists get a MAPPED arguments
// object in Node: arguments[i] and the i-th parameter alias each other.
// When the function never writes arguments, never lets it escape, and
// never writes a parameter whose index some read can reach, the aliasing
// cannot be observed, so these functions compile natively.

// arguments.length and constant-index reads beside the named parameters
// (glob@7's globSync guard).
function globSync(pattern, options) {
  if (typeof options === 'function' || arguments.length === 3)
    return 'callback provided to sync glob';
  return 'sync ' + pattern + ' ' + (options === undefined ? 'no options' : options.cwd);
}
console.log(globSync('*.js'));
console.log(globSync('*.js', { cwd: '/tmp' }));
console.log(globSync('*.js', {}, 'cb'));
console.log(globSync('*.js', function () {}));

function positions(a, b) {
  return [arguments.length, arguments[0], arguments[1], arguments[2], arguments['1'], a, b];
}
console.log(positions());
console.log(positions(1));
console.log(positions(1, 2, 3));

// A written parameter is fine while no read reaches its index (node-fetch's
// transpiled Body(body) reads only arguments.length and arguments[1]).
function Body(body) {
  var opts = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : {};
  if (body == null) body = 'empty';
  else body = 'body:' + body;
  return [body, opts.size === undefined ? 0 : opts.size, arguments.length];
}
console.log(Body(null));
console.log(Body('x', { size: 3 }));
console.log(Body(undefined, undefined));

// A same-named parameter of a nested function is a different binding.
function shadowed(a) {
  (function (a) { a = 'inner'; return a; })('x');
  var write = function (other) { other = 2; return other; };
  write(1);
  return [arguments[0], a];
}
console.log(shadowed('outer'));

// Every index is read through these forms; no parameter is written.
function total() {
  var sum = 0;
  for (var i = 0; i < arguments.length; i++) sum += arguments[i];
  return sum;
}
function forwardSpread(a, b) { return total(...arguments); }
function forwardApply(a, b) { return total.apply(null, arguments); }
function copied(a) { return Array.prototype.slice.call(arguments, 1); }
function copiedAll(a, b) { return Array.prototype.slice.call(arguments); }
function listed(a) { return Array.from(arguments); }
function mapped(a) { return Array.from(arguments, function (v) { return v * 10; }); }
function spreadArray(a) { return [...arguments, 'end']; }
function indexed(a, b) {
  var out = [];
  for (var i = arguments.length - 1; i >= 0; i--) out.push(arguments[i]);
  return out.join(',') + ' ' + a + b;
}
console.log(forwardSpread(1, 2, 3), forwardSpread(4), forwardApply(5, 6, 7), forwardApply());
console.log(copied(1, 2, 3), copied(1), copiedAll('p', 'q'));
console.log(listed('x', 'y'), mapped(1, 2, 3), spreadArray(1, 2));
console.log(indexed('a', 'b', 'c'));

// Arrows read the enclosing function's arguments.
function later(a) {
  return () => arguments[1] + ':' + arguments.length + ':' + a;
}
console.log(later('x', 'y')());

// Object-literal methods are sloppy too.
var methods = {
  first(a, b) { return arguments.length + ' ' + a + ' ' + arguments[1]; },
  none() { return arguments.length; },
};
console.log(methods.first(1, 2, 3), methods.first(), methods.none(1, 2));

// Through values: the hidden array still carries every argument.
var viaValue = positions;
console.log(viaValue('v', 'w', 'z'));
var expressions = [function (x) { return arguments.length + x; }, globSync];
console.log(expressions[0](1, 2), expressions[1]('*.ts', {}, 'cb'));
function callWith(fn) { return fn('a', 'b', 'c'); }
console.log(callWith(positions));

// signal-exit's emit wrapper: forward everything with apply.
var emitter = {
  calls: [],
  emit: function (ev, arg) { this.calls.push(Array.prototype.slice.call(arguments).join('/')); return true; },
};
var original = emitter.emit;
emitter.emit = function processEmit(ev, arg) {
  if (ev === 'exit') {
    if (arg !== undefined) emitter.code = arg;
    var ret = original.apply(this, arguments);
    return ret;
  }
  return original.apply(this, arguments);
};
emitter.emit('exit', 3, 'extra');
emitter.emit('other');
console.log(emitter.calls, emitter.code);

// Forwarding through an untyped function value with apply.
function forward(fn) {
  return function (a, b) {
    return fn.apply(null, arguments);
  };
}
var joined = forward(function (x, y, z) { return [x, y, z].join('-'); });
console.log(joined(1, 2, 3), joined('only'));

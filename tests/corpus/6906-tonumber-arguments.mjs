// Arguments that the global number functions convert with ToNumber, in a
// JavaScript file where they arrive as strings, booleans, null, undefined
// or dynamic values: isNaN, isFinite, Math functions and
// String.fromCharCode match Node for each.
console.log(isNaN("12"), isNaN("abc"), isNaN(true), isNaN(null), isNaN(undefined));
console.log(isFinite("12"), isFinite("abc"), isFinite(true), isFinite(null), isFinite(undefined));
console.log(Math.floor("3.7"), Math.max("4", 2), Math.abs(false), Math.sqrt(null), String.fromCharCode("65", true));

const parsed = JSON.parse('["12", " 0x10 ", "", "1e400", true, null, {}, [], [7]]');
for (const value of parsed) console.log(JSON.stringify(value), isNaN(value), isFinite(value), Math.trunc(value));

let calls = "";
const boxed = { valueOf: () => ((calls += "v"), 4.5), toString: () => ((calls += "s"), "9") };
console.log(isFinite(boxed), isNaN(boxed), Math.round(boxed), calls);

class LruCache {
  constructor(config) {
    this.maxAge = config.maxAge;
  }
  hasMaxAge() {
    return isFinite(this.maxAge);
  }
}
console.log(new LruCache({ maxAge: 1000 }).hasMaxAge(), new LruCache({}).hasMaxAge());

for (const value of [Symbol("s"), 10n]) {
  try {
    isFinite(value);
  } catch (e) {
    console.log(e instanceof TypeError, e.message);
  }
}

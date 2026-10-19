// @deferred-fences: 1
// `s.match(re) || []` types the empty array as an empty tuple that the
// typescript-go API panics to describe (moment.js's configFromStringAndFormat).
// The panic stays with the statements whose lowering asks about that
// type, so the rest of the program compiles and runs.

/** @param {string} s */
function firstDigit(s) {
  return (s.match(/\d/) || [])[0];
}

/** @param {string} s */
function digitCount(s) {
  let count = 0;
  for (const ch of s) if (ch >= '0' && ch <= '9') count++;
  return count;
}

const parsers = { firstDigit, digitCount };
console.log(typeof parsers.firstDigit, parsers.digitCount('a1b22'));

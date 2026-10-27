// JavaScript keeps an explicit nullable parameter's record representation.
/** @param {{a:number,b:number}|null|undefined} value */
function names(value) {
  let result = "";
  for (const key in value) result += key;
  return result;
}
console.log("names", names(null), names(undefined), names({a:1,b:2}));

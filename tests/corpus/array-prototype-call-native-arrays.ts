// Array.prototype methods called with .call on native arrays run the arrays' own
// methods, which mutate the array in place: copyWithin, fill, reverse,
// sort, push, pop, splice, and the read-only join, indexOf and includes.
const optional: (number | undefined)[] = [1, 2, 3, 4];
Array.prototype.copyWithin.call(optional, 0, 2, 4);
console.log(optional.join(","));
const nums: number[] = [5, 1, 4, 2, 3];
Array.prototype.fill.call(nums, 0, 0, 1);
console.log(nums.join(","));
console.log(Array.prototype.reverse.call(nums) === nums, nums.join(","));
Array.prototype.sort.call(nums, (a: number, b: number) => a - b);
console.log(nums.join(","));
console.log(Array.prototype.push.call(nums, 9, 10), nums.join(","));
console.log(Array.prototype.pop.call(nums), nums.length);
console.log(Array.prototype.splice.call(nums, 1, 2).join(","), nums.join(","));
console.log(Array.prototype.join.call(nums, "-"), Array.prototype.indexOf.call(nums, 4));
const words: string[] = ["c", "a", "b"];
Array.prototype.sort.call(words);
console.log(words.join(","), Array.prototype.includes.call(words, "a"));
const records: { id: number }[] = [{ id: 1 }, { id: 2 }, { id: 3 }];
Array.prototype.copyWithin.call(records, 1, 0, 1);
console.log(records.map((r) => r.id).join(","), records[0] === records[1]);

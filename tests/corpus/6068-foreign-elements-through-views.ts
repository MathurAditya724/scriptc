// A typed array seen as `unknown[]` holds the values written through the
// view that its element type cannot hold, as in Node. The view and the typed
// array are the same array: length, the view's reads and iteration,
// printing, JSON, join, searches, copies, Math over a spread, sorting and
// truncation see the written values.

const numbers: number[] = [1, 2];
const numbersView: unknown[] = numbers;
numbersView.push("x");
numbersView[0] = true;
console.log(numbers.length, numbersView.length, numbers === numbersView);
console.log(numbersView[0], numbersView[2], typeof numbersView[2]);
console.log(numbers, String(numbers), numbers.join("|"), JSON.stringify(numbers));
for (const value of numbersView) console.log("value", value, typeof value);
console.log(numbers.indexOf(2), numbers.includes(2));
console.log([...numbers], numbers.slice(1), numbers.concat([9]));

// Math over a spread applies ToNumber to every element, as in Node.
const digits: number[] = [5];
const digitsView: unknown[] = digits;
digitsView.push("4", null);
console.log(Math.max(...digits), Math.min(...digits), Math.hypot(...digits));

// Present undefined, null and objects keep their own values.
const mixed: number[] = [1];
const mixedView: unknown[] = mixed;
mixedView.push(undefined, null, { a: 1 }, [2, 3]);
console.log(mixed, mixed.length, 1 in mixed, mixedView[2] === null);
console.log(JSON.stringify(mixed), mixed.join("-"));

// Writing a number over a foreign element makes it a number again.
const replaced: number[] = [1, 2];
const replacedView: unknown[] = replaced;
replacedView.push("x");
replaced[2] = 5;
console.log(replaced, replacedView, replaced[2] + 1);

// Default sort orders every element by its string, as in Node.
const sorted: number[] = [10, 9, 1];
const sortedView: unknown[] = sorted;
sortedView.push("b", "a");
console.log(sorted.sort(), sorted.length, sortedView[4]);

// Truncation drops written values; growing again leaves holes.
const truncated: number[] = [1];
const truncatedView: unknown[] = truncated;
truncatedView.push("x", "y");
truncated.length = 1;
truncated.length = 3;
console.log(truncated, truncatedView.length);

// string[] and class arrays hold values of other types the same way.
const words: string[] = ["a"];
const wordsView: unknown[] = words;
wordsView.push(1, false);
console.log(words, words.join("-"), words.length, typeof wordsView[1]);

class Item {
  id: string;
  constructor(id: string) {
    this.id = id;
  }
}
const items: Item[] = [new Item("a")];
const itemsView: unknown[] = items;
itemsView.push({ id: "plain" });
console.log(items, items.length, items[0]!.id, itemsView[1] instanceof Item);

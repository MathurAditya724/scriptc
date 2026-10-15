// Module-level numbers accumulated by top-level loops: calls in the loop
// read them while the loop keeps them as integers, and sums that leave
// the safe integers continue as doubles.

let total: number = 0;
let calls: number = 0;
let big: number = 9007199254740000;

function peek(): number {
  calls++;
  return total;
}

for (let i: number = 0; i < 1000; i++) {
  total = total + (i % 7);
  if (i % 250 === 0) console.log("peek", peek());
}
console.log("total", total, "calls", calls);

for (let i: number = 0; i < 3000; i++) big += i;
console.log("big", big, Number.isSafeInteger(big));

let product: number = 1;
let rounds: number = 0;
while (rounds < 70) {
  product = product * 3;
  rounds++;
}
console.log("product", product);

let zero: number = 1;
for (let i: number = 0; i < 2; i++) zero = zero * -0;
console.log("zero", Object.is(zero, -0));

let mixed: number = 10;
for (let i: number = 0; i < 6; i++) {
  mixed = mixed - 3;
  mixed = mixed * 2;
}
console.log("mixed", mixed);

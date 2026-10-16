// Locals bound to union results with several reference arms: rebinding in
// loops, leaving the scope through break, continue, return and throw, and
// comparisons and narrowing of the bound value.
class Cat {
  name: string;
  constructor(name: string) {
    this.name = name;
  }
}
class Dog {
  name: string;
  constructor(name: string) {
    this.name = name;
  }
}
class Fish {
  fins: number;
  constructor(fins: number) {
    this.fins = fins;
  }
}
type Pet = Cat | Dog | Fish | string;

const shelter: Pet[] = [];
function adopt(i: number): Pet {
  if (i % 4 === 0) return new Cat("cat" + String(i));
  if (i % 4 === 1) return new Dog("dog" + String(i));
  if (i % 4 === 2) return i > 5 ? new Fish(i) : shelter[0] ?? "empty";
  return "pet" + String(i);
}
function label(p: Pet): string {
  if (typeof p === "string") return p;
  return p instanceof Fish ? "fish" + String(p.fins) : p.name;
}

function name(p: Pet): string {
  return label(p);
}

// Rebinding in a loop; each new value replaces the previous one. The bound
// values are only compared and narrowed.
let current: Pet = adopt(0);
let score = 0;
for (let i = 1; i < 12; i++) {
  const next = adopt(i);
  if (next === current) score += 100;
  if (typeof next === "string") score += next.length;
  else if (next instanceof Fish) score += next.fins;
  else score += next.name.length;
  current = adopt(i + 1);
}
console.log(score, typeof current, current instanceof Cat);

// Early exits with a bound value in scope.
function firstFish(limit: number): number {
  for (let i = 0; i < limit; i++) {
    const p = adopt(i);
    if (typeof p === "string") continue;
    if (p instanceof Fish) return p.fins;
    if (i > 8) break;
  }
  return -1;
}
console.log(firstFish(3), firstFish(20), firstFish(0));

function strict(i: number): number {
  const p = adopt(i);
  if (p instanceof Dog) throw new Error("no dogs: " + p.name);
  return typeof p === "string" ? p.length : p instanceof Cat ? p.name.length : p.fins;
}
const results: string[] = [];
for (let i = 0; i < 6; i++) {
  try {
    results.push(String(strict(i)));
  } catch (error) {
    results.push((error as Error).message);
  }
}
console.log(results.join(" | "));

// Identity comparisons between bound and fresh results.
shelter.push(new Cat("resident"));
const resident = adopt(2);
let same = 0;
for (let i = 0; i < 40; i++) if (adopt(i % 3 === 0 ? 2 : i) === resident) same++;
console.log(same, resident === shelter[0], adopt(2) === shelter[0]);

// Conditionals, nested scopes, and values that escape through a call.
for (let round = 0; round < 3; round++) {
  const a = round % 2 === 0 ? adopt(round) : adopt(round + 4);
  {
    const b = adopt(round + 1);
    console.log(round, a === b, typeof a, b instanceof Dog);
  }
  console.log(name(adopt(round)), label(adopt(round + 2)));
}

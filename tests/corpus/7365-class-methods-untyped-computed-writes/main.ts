// Typed classes next to untyped computed writes. Calls through a typed
// receiver keep the method while its prototype slot holds the declared
// method, and observe a replacement made by untyped code (on the prototype
// or as an own property of one instance) exactly as Node does.
import { patch, tally, unpatch } from "./untyped.js";

class Repository {
  private items = new Map<string, number>();
  add(name: string, cents: number): number {
    this.items.set(name, cents);
    return this.items.size;
  }
  list(): string[] {
    return [...this.items.keys()];
  }
  total(): number {
    let sum = 0;
    for (const cents of this.items.values()) sum += cents;
    return sum;
  }
}

const words: string[] = ["list", "add", "list", "total"];
console.log(JSON.stringify(tally(words)));

const repo = new Repository();
repo.add("keyboard", 12900);
repo.add("mouse", 4900);
let sum = 0;
for (let i = 0; i < 1000; i++) sum += repo.total();
console.log(repo.list().join(","), sum);

// untyped code replaces the method on the prototype
const proto: unknown = Object.getPrototypeOf(repo);
patch(proto, "total", function (this: Repository): number {
  return -1;
});
console.log(repo.total(), new Repository().total());
unpatch(proto, "total");
try {
  repo.total();
} catch (error) {
  console.log("after delete:", error instanceof TypeError);
}

// an own replacement on one instance shadows the prototype for that instance only
const other = new Repository();
other.add("cable", 900);
patch(other, "list", () => ["shadowed"]);
console.log(other.list().join(","), repo.list().join(","));
unpatch(other, "list");
console.log(other.list().join(","));

// restoring the original value through the prototype brings back the method
const saved: unknown = (proto as Record<string, unknown>)["list"];
patch(proto, "list", () => ["patched"]);
console.log(repo.list().join(","));
patch(proto, "list", saved);
console.log(repo.list().join(","));

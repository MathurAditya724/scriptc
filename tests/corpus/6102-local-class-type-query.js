// A whole-program analysis that queries types before reachability is known
// (the computed-key write census here) can name a function-local class whose
// collection is refused. That query has no owner for the refusal: the class
// stays unmapped for it, and the refusal belongs to the class's own
// declaration, which this program never executes (it used to crash the
// compiler with an uncaught PoisonError).
function main(run) {
  if (!run) return "skipped";
  const Project = class {
    constructor() {
      this.name = "p";
    }
    close() {
      if (this.missingFilesMap) {
        this.missingFilesMap.clear();
        this.missingFilesMap = void 0;
      }
    }
    add(k) {
      (this.missingFilesMap || (this.missingFilesMap = new Map())).set(k, 1);
    }
  };
  const holder = { p: new Project() };
  const key = String(run);
  holder.p[key] = "q";
  return holder.p.name;
}

class Counter {
  constructor() {
    this.counts = {};
  }
  bump(key) {
    this.counts[key] = (this.counts[key] || 0) + 1;
    return this.counts[key];
  }
}

const counter = new Counter();
const word = process.argv.length > 99 ? "unused" : "word";
counter.bump(word);
console.log(main(0), counter.bump(word));

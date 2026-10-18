// Fields read before their assignment through code that construction runs
// read undefined, as in Node; constructions that run no such code keep
// their values and layouts.
const registry: Registered[] = [];
function peek(target: Peeked): void {
  console.log("peek", target.late, typeof target.late);
}
class Peeked {
  early = 1;
  late: number;
  constructor() {
    peek(this);
    this.late = 2;
  }
}
console.log(new Peeked().late);

function register(target: Registered): void {
  registry.push(target);
}
function report(): void {
  for (const entry of registry) console.log("registered", entry.value);
}
class Registered {
  value: string;
  constructor() {
    register(this);
    report();
    this.value = "set";
  }
}
new Registered();
report();

class Reader {
  owner: Visited;
  constructor(owner: Visited) {
    this.owner = owner;
    console.log("reader", owner.count);
  }
}
class Visited {
  count: number;
  reader: Reader;
  constructor() {
    this.reader = new Reader(this);
    this.count = 3;
  }
}
console.log(new Visited().reader.owner.count);

class Keeper {
  owner: Kept;
  constructor(owner: Kept) {
    this.owner = owner;
  }
  show(): number {
    return this.owner.total;
  }
}
class Kept {
  keeper: Keeper;
  total: number;
  constructor() {
    this.keeper = new Keeper(this);
    console.log("kept", this.keeper.show());
    this.total = 4;
  }
}
console.log(new Kept().keeper.show());

class Callback {
  run: () => number;
  size: number;
  constructor(invoke: (f: () => number) => void) {
    this.run = () => this.size * 2;
    invoke(this.run);
    this.size = 5;
  }
}
console.log(new Callback((f) => console.log("callback", f())).run());

class Overridden {
  constructor() {
    this.setup();
  }
  setup(): void {}
}
class Overrider extends Overridden {
  limit: number = 6;
  setup(): void {
    console.log("setup", this.limit);
  }
}
console.log(new Overrider().limit);

class Branches {
  mode: string;
  width: number;
  steps: number[];
  constructor(wide: boolean) {
    if (wide) {
      this.mode = "wide";
      this.width = 80;
    } else {
      this.mode = "narrow";
      this.width = 40;
    }
    this.steps = [];
    for (let i = 0; i < 3; i++) this.steps.push(i * this.width);
    this.describe();
  }
  describe(): void {
    console.log(this.mode, this.width, this.steps.join(","));
  }
}
new Branches(true);
new Branches(false);

class Counter {
  constructor() {
    this.start();
  }
  start(): void {}
}
class Cursor extends Counter {
  at: number;
  total: number;
  items: string[];
  constructor() {
    super();
    this.at = 0;
    this.total = 0;
    this.items = ["a", "b", "c"];
  }
  start(): void {
    this.total += 1;
    console.log("start", this.at, this.total, this.at === undefined);
  }
  next(): string | undefined {
    return this.items[this.at++];
  }
}
const cursor = new Cursor();
console.log(cursor.next(), cursor.next(), cursor.at, cursor.total);

function widthOf(header: Header): number {
  return header.data.length * 2;
}
class Header {
  data: number[];
  first: number;
  doubled: number;
  view: HeaderView;
  format = (value: number) => `${this.data.length}:${value}`;
  constructor(data: number[]) {
    this.data = data;
    this.first = this.at(0);
    this.doubled = widthOf(this);
    this.view = new HeaderView(this);
  }
  at(index: number): number {
    if (index >= this.data.length) return -1;
    return this.data[index]!;
  }
}
class HeaderView {
  header: Header;
  size: number;
  constructor(header: Header) {
    this.header = header;
    this.size = header.data.length;
  }
}
const header = new Header([7, 8, 9]);
console.log(header.first, header.doubled, header.view.size, header.format(header.first));

class Panel {
  width: number;
  constructor() {
    this.render();
    this.width = 3;
  }
  render(): void {}
}
Panel.prototype.render = function (this: Panel) {
  console.log("render", this.width);
};
console.log(new Panel().width);

// @transform-types
// Fields that a base constructor (or the constructor itself) can read
// through an override or a method call before they are assigned hold
// undefined then, as in Node, for every field kind. After construction
// the fields read and update normally.
class Point {
  x: number;
  constructor(x: number) {
    this.x = x;
  }
}
function show(label: string, value: number): string {
  return `${label}=${value}`;
}
abstract class Widget {
  log: string[] = [];
  constructor() {
    this.describe("base");
  }
  abstract describe(when: string): void;
}
class Panel extends Widget {
  label: string;
  width: number;
  visible: boolean;
  origin: Point;
  items: number[];
  options: { depth: number };
  key: string | number;
  index: Map<string, number>;
  tags: Set<string>;
  count = 5;
  constructor(label: string, readonly id: string) {
    super();
    this.label = label;
    this.width = 10;
    this.visible = true;
    this.origin = new Point(1);
    this.items = [1, 2];
    this.options = { depth: 2 };
    this.key = 7;
    this.index = new Map([["a", 1]]);
    this.tags = new Set(["t"]);
    this.describe("ctor");
  }
  describe(when: string): void {
    console.log(when, this.label, this.width, this.visible, this.origin, this.items, this.options, this.key, this.count, this.id);
    console.log(when, `${this.label}:${this.width}`, this.width + 1, this.count * 2, this.label === undefined, typeof this.items, this.origin?.x, this.options?.depth ?? -1, this.index?.size, this.tags?.has("t"));
    console.log(when, show(this.label, this.width), String(this.key), [this.label].length);
    try {
      console.log(this.label.length, this.items.length);
    } catch (error) {
      console.log(when, (error as Error).message);
    }
  }
  grow(): number {
    this.count++;
    this.width += 5;
    this.label += "!";
    this.items.push(this.width);
    return this.count + this.width + this.items.length;
  }
}
const panel = new Panel("main", "p1");
console.log(panel.grow(), panel.label, panel.items, panel.count, panel.width);

class Plain {
  total: number;
  name: string;
  constructor() {
    this.total = 1;
    this.name = "plain";
    this.bump();
  }
  bump(): void {
    this.total++;
  }
}
const plain = new Plain();
console.log(plain.total, plain.name);

class Toucher {
  constructor() {
    this.touch();
  }
  touch(): void {}
}
class Counter extends Toucher {
  count = 0;
  label: string;
  items: string[];
  constructor() {
    super();
    this.label = "c";
    this.items = [];
  }
  override touch(): void {
    this.count++;
    this.label += "x";
    console.log(this.count, this.label, Number.isNaN(this.count));
    try {
      this.items.push("a");
    } catch (error) {
      console.log(error instanceof TypeError);
    }
  }
}
const c = new Counter();
c.touch();
console.log(c.count, c.label, c.items);

class Shower {
  constructor() {
    this.show();
  }
  show(): void {}
}
class Box<T> extends Shower {
  label: string;
  value: T;
  constructor(value: T) {
    super();
    this.label = "box";
    this.value = value;
  }
  override show(): void {
    console.log("show", this.label, this.value);
  }
}
new Box<number>(3).show();
new Box<string>("s").show();

type Ctor<T = {}> = new (...args: any[]) => T;
class Viewer {
  constructor() {
    this.show();
  }
  show(): void {}
}
function Labeled<B extends Ctor<Viewer>>(Parent: B) {
  return class extends Parent {
    label = "mixed";
    override show(): void {
      console.log("show", this.label);
    }
  };
}
const L = Labeled(Viewer);
new L().show();

interface Crash { loc: number; message: string }
class Setupper {
  constructor() {
    this.setup();
  }
  setup(): void {}
}
class Host extends Setupper {
  crash: Crash | null;
  name: string | null;
  constructor(c: Crash | null) {
    super();
    this.crash = c;
    this.name = "host";
  }
  override setup(): void {
    console.log("setup", this.crash, this.name);
    if (this.crash !== null) {
      try {
        console.log(this.crash.loc);
      } catch (error) {
        console.log(error instanceof TypeError);
      }
    }
  }
  report(): string {
    if (this.crash) return `${this.crash.message} at ${this.crash.loc}`;
    return this.name === null ? "none" : this.name.toUpperCase();
  }
}
console.log(new Host({ loc: 3, message: "boom" }).report(), new Host(null).report());

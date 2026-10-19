// A helper the constructor may skip (in a loop, a short circuit or a
// conditional expression) leaves the fields it writes unassigned, and a
// branch or skipped helper that overwrites a closure field may leave the
// earlier closure in place.
class Grid {
  cells!: number[];
  rows: number;
  constructor(rows: number) {
    this.rows = rows;
    for (let i = 0; i < rows; i++) this.reset();
    console.log(this.cells?.length);
  }
  private reset(): void {
    this.cells = [0, 0];
  }
}
new Grid(0);
new Grid(1);

class Flag {
  label!: string;
  note!: string;
  constructor(on: boolean) {
    on && this.init();
    const extra = on ? this.annotate() : 0;
    console.log(this.label?.length, this.note?.length, extra);
  }
  private init(): void {
    this.label = "on";
  }
  private annotate(): number {
    this.note = "noted";
    return 1;
  }
}
new Flag(false);
new Flag(true);

class Box {
  f!: () => string | undefined;
  name!: string;
  constructor(flag: boolean) {
    this.f = () => this.name;
    if (flag) this.f = () => "fixed";
    const g = this.f;
    console.log(g()?.length);
    this.name = "box";
  }
}
new Box(true);
new Box(false);

class Lazy {
  f!: () => string | undefined;
  name!: string;
  constructor(n: number) {
    this.f = () => this.name;
    for (let i = 0; i < n; i++) this.reset();
    const g = this.f;
    console.log(g()?.length);
    this.name = "lazy";
  }
  private reset(): void {
    this.f = () => "reset";
  }
}
new Lazy(0);
new Lazy(1);

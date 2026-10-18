// JavaScript class fields that the constructor creates after it calls a
// method, or after a base constructor that does, hold undefined until
// they are assigned, as in Node.
class Widget {
  constructor(name) {
    this.render();
    this.name = name;
    this.size = 3;
    this.title = "widget";
    this.parts = ["a"];
    this.meta = { id: 1 };
  }
  render() {
    console.log("render", this.name, this.title, this.size, this.parts, this.meta, this.size + 1, `${this.name}!`);
  }
}
class Big extends Widget {
  constructor() {
    super("big");
    this.extra = 2;
  }
  render() {
    super.render();
    console.log("big", this.extra);
  }
}
new Widget("w").render();
new Big().render();

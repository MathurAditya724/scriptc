import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule, validateModule } from "../src/index.js";
import type { IrModule } from "../src/ir/ir.js";

async function lower(source: string, file = "main.ts"): Promise<IrModule> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-early-field-reads-"));
  try {
    const entry = join(dir, file),
      output = join(dir, "main.ir.json");
    await writeFile(entry, source);
    const result = await compile(entry, { outDir: dir, outPath: output, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((item) => `${item.code}: ${item.message}`).join("\n"));
    const module = deserializeModule(await readFile(output, "utf8"));
    expect(validateModule(module)).toEqual([]);
    return module;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Field name → IR kind for a class. */
function fields(module: IrModule, name: string): string {
  const cls = module.classes.find((candidate) => candidate.name === name);
  expect(cls, name).toBeDefined();
  return cls!.fields
    .filter((field) => !field.name.startsWith("%"))
    .map((field) => `${field.name}:${field.type.kind}`)
    .join(" ");
}

test("fields assigned after construction can call an override admit undefined", async () => {
  const module = await lower(`
abstract class Base {
  constructor() {
    this.describe();
  }
  abstract describe(): void;
}
class Panel extends Base {
  label: string;
  width: number;
  count = 0;
  constructor() {
    super();
    this.label = "panel";
    this.width = 2;
  }
  describe(): void {
    console.log(this.label, this.width, this.count);
  }
}
class Plain {
  label: string;
  width: number;
  constructor() {
    this.label = "plain";
    this.width = 1;
    this.describe();
  }
  describe(): void {
    console.log(this.label, this.width);
  }
}
new Panel();
new Plain();
`);
  expect(fields(module, "Panel")).toBe("label:union width:union count:union");
  expect(fields(module, "Plain")).toBe("label:string width:f64");
});

test("JavaScript fields created after the constructor calls a method admit undefined", async () => {
  const module = await lower(
    `
class Widget {
  constructor() {
    this.ready = true;
    this.render();
    this.title = "widget";
  }
  render() {
    console.log(this.ready, this.title);
  }
}
new Widget();
`,
    "main.js",
  );
  expect(fields(module, "Widget")).toBe("ready:bool title:union");
});

test("constructions that run no other code keep plain field layouts", async () => {
  const module = await lower(`
class Scanner {
  chars: Uint16Array;
  end: number;
  pos: number;
  constructor(text: string, onDemand: boolean) {
    if (onDemand) {
      this.chars = new Uint16Array(text.length + 4);
    } else {
      this.chars = new Uint16Array(text.length);
    }
    for (let i = 0; i < 2; i++) this.chars[i] = i;
    this.end = text.length | 0;
    this.pos = 0;
  }
}
function widthOf(header: Header): number {
  return header.data.length * 2;
}
class Header {
  data: number[];
  first: number;
  width: number;
  view: HeaderView;
  format = (value: number) => this.data.length + value;
  constructor(data: number[]) {
    this.data = data;
    this.first = this.at(0);
    this.width = widthOf(this);
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
const scanner = new Scanner("abc", false);
const header = new Header([1, 2]);
console.log(scanner.end, scanner.pos, header.first, header.width, header.view.size, header.format(1));
`);
  expect(fields(module, "Scanner")).toBe("chars:bytes end:f64 pos:f64");
  expect(fields(module, "Header")).toBe("data:array first:f64 width:f64 view:object format:func");
  expect(fields(module, "HeaderView")).toBe("header:object size:f64");
});

test("updates of an early-read number field stay numeric", async () => {
  const module = await lower(`
class Base {
  constructor() {
    this.start();
  }
  start(): void {}
}
class Cursor extends Base {
  at: number;
  items: string[];
  constructor() {
    super();
    this.at = 0;
    this.items = ["a", "b"];
  }
  start(): void {
    console.log(this.at);
  }
  next(): string | undefined {
    return this.items[this.at++];
  }
}
const cursor = new Cursor();
console.log(cursor.next(), cursor.next());
`);
  expect(fields(module, "Cursor")).toBe("at:union items:union");
  expect(JSON.stringify(module.functions)).not.toContain('"dynKeyGet"');
});

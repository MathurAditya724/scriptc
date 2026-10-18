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

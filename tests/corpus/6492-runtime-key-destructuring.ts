// Object destructuring with a runtime computed key (`const { [name]: v } =
// source`): an index-signature record reads its entry (undefined when
// absent, where a default applies), and a key whose type is a union of
// literal field names reads the field it names. Keys evaluate once, in
// element order.
const weights: Record<string, number> = { a: 1, b: 2 };
function pick(k: string): string {
  const { [k]: w } = weights;
  return `${k}=${w}`;
}
console.log(pick("a"), pick("b"), pick("z"));

function withDefault(k: string): number {
  const { [k]: w = -1 } = weights;
  return w;
}
console.log(withDefault("a"), withDefault("missing"));

type Side = "left" | "right";
const pair = { left: 10, right: 20, label: "p" };
function side(s: Side): number {
  const { [s]: v, label } = pair;
  return v + label.length;
}
console.log(side("left"), side("right"));

let trace = "";
function key(k: string): string {
  trace += `key:${k};`;
  return k;
}
const { [key("a")]: first, [key("b")]: second, [key("c")]: third = 0 } = weights;
console.log(first, second, third, trace);

// Parameters and nested patterns take the same path.
const labels: { [code: string]: string } = { ok: "fine", err: "broken" };
function describe(code: string, { [code]: text }: { [code: string]: string }): string {
  return `${code}:${text ?? "unknown"}`;
}
console.log(describe("ok", labels), describe("err", labels), describe("wat", labels));
const config = { limits: { cpu: 2, memory: 512 } as Record<string, number> };
for (const resource of ["cpu", "memory", "disk"]) {
  const {
    limits: { [resource]: limit = 0 },
  } = config;
  console.log(resource, limit);
}

// A module-scope binding from a missing index-signature entry holds
// undefined.
const missingKey = process.argv.length > 99 ? "a" : "missing";
const { [missingKey]: missingWeight } = weights;
console.log(missingWeight, missingWeight === undefined);

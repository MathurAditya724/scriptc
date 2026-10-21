// An untyped configuration read once at startup: dynamic, but not hot, so
// the build names nothing. The hot loop is typed.
const config: any = JSON.parse('{"scale": 3, "label": "sum"}');
const scale: number = config.scale;
const label: string = config.label;

function sum(values: number[]): number {
  let total = 0;
  for (const v of values) total += v * scale;
  return total;
}

console.log(label, sum([1, 2, 3]));

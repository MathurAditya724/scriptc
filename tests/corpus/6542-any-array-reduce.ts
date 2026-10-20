// reduce and reduceRight over an `any[]`: the array lives in the checked
// dynamic tree, so the runtime's own Array.prototype.reduce runs the
// callback, with or without an initial value.
class Ref {
  kind: string;
  size: number;
  constructor(kind: string, size: number) {
    this.kind = kind;
    this.size = size;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rebuild(entries: any[]): any {
  return entries.reduce((acc, [key, value]) => {
    if (value.type === 'ref') acc[key] = new Ref(value.type, value.size);
    else acc[key] = { other: value.type };
    return acc;
  }, {});
}

const out = rebuild(JSON.parse('[["x",{"type":"ref","size":3}],["y",{"type":"plain"}]]'));
console.log(Object.keys(out), out.x instanceof Ref, out.x.size, out.y.other);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const nums: any[] = JSON.parse('[1, 2, 3, 4]');
console.log(nums.reduce((sum, n) => sum + n, 0));
console.log(nums.reduce((sum, n) => sum + n));
console.log(nums.reduceRight((text, n) => text + String(n), ''));
console.log(nums.reduce((acc, n, index) => acc + n * index, 0));
try {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (JSON.parse('[]') as any[]).reduce((sum, n) => sum + n);
} catch (error) {
  console.log((error as Error).name, (error as Error).message);
}

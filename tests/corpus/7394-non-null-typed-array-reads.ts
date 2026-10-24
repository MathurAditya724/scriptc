// Non-null assertions on typed-array element reads. `!` performs no
// runtime check: an index outside the array reads undefined, as in Node,
// wherever the use tells undefined from NaN (equality, string conversion,
// typeof, Object.is, an array element), and NaN where it converts the value
// to a number.

const int32 = new Int32Array([1, -2, 3]);
const float64 = new Float64Array([1.5, NaN, -0]);
const uint8 = new Uint8Array([7, 255]);

function show(v: unknown): string {
  return Object.is(v, -0) ? "-0" : String(v);
}

function line(label: string, parts: unknown[]): void {
  console.log(label.padEnd(12), parts.map(show).join(" "));
}

for (const k of [0, 1, 2, 3, -1, 1.5]) {
  line(`int32 ${k}`, [
    int32[k]! === int32[k]!,
    int32[k]! !== int32[0]!,
    int32[k]! === undefined,
    int32[k]! == null,
    Object.is(int32[k]!, undefined),
    typeof int32[k]!,
    `${int32[k]!}`,
    "v=" + int32[k]!,
    String(int32[k]!),
    int32[k]! + 1,
    int32[k]! < 2,
    [int32[k]!].length,
  ]);
  line(`float64 ${k}`, [
    float64[k]! === float64[k]!,
    float64[k]! === undefined,
    Object.is(float64[k]!, NaN),
    typeof float64[k]!,
    `${float64[k]!}`,
    float64[k]! * 2,
    -float64[k]!,
  ]);
  line(`uint8 ${k}`, [
    uint8[k]! === uint8[k]!,
    uint8[k]! == undefined,
    typeof uint8[k]!,
    `${uint8[k]!}`,
    uint8[k]! | 0,
    uint8[k]! > 100,
  ]);
}

const optional: number | undefined = uint8[5]!;
const listed = [int32[9]!, float64[0]!];
line("slots", [optional, listed[0], listed[1], listed.length]);

let total = 0;
for (let i = 0; i <= int32.length; i++) total += int32[i]!;
line("sum", [total]);

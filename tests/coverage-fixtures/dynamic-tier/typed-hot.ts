// TypeScript functions that loop over untyped values: an `any` parameter
// and an untyped JSON.parse result (SC6101 names both).
function regionTotals(items: any): Map<string, number> {
  const out = new Map<string, number>();
  for (const item of items) out.set(item.region, (out.get(item.region) ?? 0) + item.amount);
  return out;
}

function countRegions(text: string): number {
  const parsed = JSON.parse(text);
  let n = 0;
  for (let i = 0; i < parsed.length; i++) if (parsed[i].region !== "") n++;
  return n;
}

const rows = [
  { amount: 3, region: "eu" },
  { amount: 4, region: "us" },
];
for (const [region, total] of regionTotals(rows)) console.log(region, total);
console.log(countRegions(JSON.stringify(rows)));

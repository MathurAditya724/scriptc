// Members whose JSON type differs from the declared one keep their real
// values and JavaScript semantics after a failed checked cast.
interface Reading {
  sensor: string;
  value: number;
  ok: boolean | number;
  samples: number[];
}

function report(text: string): string {
  const r = JSON.parse(text) as Reading;
  const doubled = r.value * 2;
  const sum = r.value + 1;
  console.log(r.sensor, typeof r.sensor, r.value, typeof r.value, doubled, sum);
  console.log("ok:", r.ok, typeof r.ok, r.ok === true, r.ok == 1);
  console.log("cmp:", r.value > 10, r.value < 10, r.value === 5);
  console.log("samples:", Array.isArray(r.samples), r.samples.length);
  let total = 0;
  for (const s of r.samples) total = total + s;
  console.log("total:", total, typeof total);
  try {
    const parts = r.samples.map((s) => typeof s);
    console.log("kinds:", parts.join(","));
  } catch (e) {
    console.log("map threw:", (e as Error).message);
  }
  return `${r.sensor}=${r.value}`;
}

console.log(report('{"sensor":"t1","value":5,"ok":true,"samples":[1,2,3]}'));
console.log(report('{"sensor":7,"value":"5","ok":1,"samples":[1,"2",3]}'));
console.log(report('{"sensor":"t3","value":null,"ok":"yes","samples":"abc"}'));
console.log(report('{"sensor":["x"],"value":{"n":1},"ok":false,"samples":[]}'));

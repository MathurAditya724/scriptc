// A failed checked cast keeps every member of the parsed object: extra
// members stay visible to Object.keys, JSON.stringify, for...in and
// util.inspect, in the source object's key order.
interface Point {
  x: number;
  y: number;
}

function show(text: string): void {
  const p = JSON.parse(text) as Point;
  console.log(Object.keys(p).join(","));
  console.log(Object.values(p).length, Object.entries(p).length);
  console.log(JSON.stringify(p));
  console.log(JSON.stringify(p, null, 2));
  const seen: string[] = [];
  for (const k in p) seen.push(k);
  console.log(seen.join("|"));
  console.log(p);
  console.log("has z:", "z" in p, Object.hasOwn(p, "z"));
}

show('{"x":1,"y":2}');
show('{"z":3,"x":"1","y":2,"label":{"text":"hi","size":[1,2]}}');
show('{"x":1}');
show('{"b":1,"a":2,"x":null,"y":[]}');

// Spread copies every member of the failed value, in source order.
function copyOf(text: string): void {
  const p = JSON.parse(text) as Point;
  const copy = { ...p, y: 10 };
  console.log(copy, Object.keys(copy).join(","));
  const pair = [p.x, p.y];
  console.log(pair, JSON.stringify({ point: p, at: [p.x] }));
}

copyOf('{"x":1,"y":2}');
copyOf('{"w":0,"x":"1","extra":true}');

// Optional keys added after construction go last, as in Node, also for
// shapes whose literals write their keys in different orders: a write of a
// missing key, a delete and a later write, and writes in a loop.
type Item = { id: number; name?: string; note?: string; count: number };

const items: Item[] = [
  { id: 1, count: 0 },
  { count: 1, name: "b", id: 2 },
  { note: "c", id: 3, count: 2 },
];
items[0]!.note = "added";
items[0]!.name = "later";
items[1]!.name = "kept";
delete items[2]!.note;
items[2]!.note = "again";
for (const item of items) {
  if (item.count > 0) item.name ??= "filled";
  console.log(JSON.stringify(item), Object.keys(item).join(","));
}
const built: Item = { count: 9, id: 9 };
for (let i = 0; i < 2; i++) {
  if (i === 1) built.note = `n${i}`;
  console.log(Object.keys(built).join(","));
}
console.log(built);
// d
// e

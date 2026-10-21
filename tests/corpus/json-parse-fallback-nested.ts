// Nested records and arrays of a value that failed its checked cast keep
// their identity: reads, writes and comparisons reach the same objects.
interface Line {
  sku: string;
  qty: number;
}
interface Cart {
  id: string;
  lines: Line[];
  owner: { name: string; email: string };
}

function lineTotal(lines: Line[]): number {
  let n = 0;
  for (const line of lines) n += line.qty;
  return n;
}

function inspectCart(text: string): void {
  const cart = JSON.parse(text) as Cart;
  const lines = cart.lines;
  console.log("same lines:", lines === cart.lines, cart.owner === cart.owner);
  lines.push({ sku: "added", qty: 1 });
  console.log("count:", cart.lines.length, lines.length);
  const first = lines[0];
  first.qty = first.qty + 10;
  console.log("first:", cart.lines[0].sku, cart.lines[0].qty);
  console.log("skus:", lines.map((l) => l.sku).join(","));
  console.log("big:", lines.filter((l) => l.qty > 5).length);
  console.log("found:", lines.find((l) => l.sku === "b")?.qty ?? "none");
  console.log("some string qty:", lines.some((l) => typeof l.qty === "string"));
  console.log("owner:", cart.owner?.name ?? "(anonymous)", cart.owner?.email);
  console.log(JSON.stringify(cart));
  // A typed function receives the lines when they fit its parameter.
  if (lines.every((l) => typeof l.qty === "number" && typeof l.sku === "string"))
    console.log("total:", lineTotal(lines));
  else console.log("total: skipped");
}

inspectCart('{"id":"c1","lines":[{"sku":"a","qty":1},{"sku":"b","qty":2}],"owner":{"name":"n","email":"e"}}');
inspectCart('{"id":"c2","lines":[{"sku":"a","qty":1},{"sku":"b","qty":2}]}');
inspectCart('{"id":3,"lines":[{"sku":"a","qty":"1"}],"owner":{"name":"n"}}');

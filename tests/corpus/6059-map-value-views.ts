// A Map whose values are class instances, read through a type whose values
// are interface views (`Map<string, Item>` returned where an interface
// declares `ReadonlyMap<string, View>`, or assigned to such a slot), is the
// same Map: identity holds, later changes on either side show on the other,
// and every read, iteration form and copy gives Node's values. Number keys,
// number values and optional results take the same view.
interface View {
  readonly name: string;
  getMembers(): ReadonlyMap<string, View>;
}

interface Table {
  rows(): Map<string, View>;
  sizes(): ReadonlyMap<string, unknown>;
  byIndex(): ReadonlyMap<number, View>;
  maybe(present: boolean): ReadonlyMap<string, View> | undefined;
}

class Item {
  readonly name: string;
  readonly members = new Map<string, Item>();
  constructor(name: string) {
    this.name = name;
  }
  getMembers(): Map<string, Item> {
    return this.members;
  }
}

class Store implements Table {
  readonly items = new Map<string, Item>();
  readonly counts = new Map<string, number>();
  readonly indexed = new Map<number, Item>();
  rows(): Map<string, Item> {
    return this.items;
  }
  sizes(): Map<string, number> {
    return this.counts;
  }
  byIndex(): Map<number, Item> {
    return this.indexed;
  }
  maybe(present: boolean): Map<string, Item> | undefined {
    return present ? this.items : undefined;
  }
}

const root = new Item("root");
root.members.set("a", new Item("a"));
root.members.set("b", new Item("b"));
const view = root as unknown as View;
const members = view.getMembers();
console.log(members === root.members, members.size, members.has("a"), members.get("b")?.name);
for (const [key, member] of members) console.log(key, member.name);
console.log([...members.keys()].join(","), [...members.values()].map((m) => m.name).join(","));
members.forEach((member, key) => console.log("each", key, member.name));
console.log(Array.from(members.entries()).length, members.get("missing"));

root.members.set("c", new Item("c"));
console.log(members.size, members.get("c")?.name);
const copy = new Map(members);
root.members.delete("a");
console.log(copy.size, members.size, copy.get("a")?.name);

const store = new Store();
store.items.set("x", new Item("x"));
const table: Table = store;
const rows = table.rows();
console.log(rows === store.items, rows.get("x")?.name);
rows.set("y", new Item("y"));
console.log(store.items.get("y")?.name, store.items.get("y") instanceof Item);
rows.delete("x");
console.log([...store.items.keys()].join(","));

store.counts.set("files", 3);
const sizes = table.sizes();
console.log(sizes.get("files"), typeof sizes.get("files"), sizes.size);
store.indexed.set(2, new Item("two"));
console.log(table.byIndex().get(2)?.name, table.byIndex().has(3));
console.log(table.maybe(true)?.get("y")?.name, table.maybe(false));
console.log(table.maybe(true) === store.items);

const direct: ReadonlyMap<string, View> = store.items;
console.log(direct === store.items, direct.get("y")?.name);
function countViews(views: ReadonlyMap<string, View>): number {
  let total = 0;
  for (const value of views.values()) total += value.name.length;
  return total;
}
console.log(countViews(store.items), countViews(root.members));
const holder: { views: ReadonlyMap<string, View> | undefined } = { views: undefined };
holder.views = store.items;
store.items.set("zz", new Item("zz"));
console.log(holder.views?.size, holder.views === store.items);
console.log(direct);

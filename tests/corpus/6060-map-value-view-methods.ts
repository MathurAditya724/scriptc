// Values read through a Map view (a `Map<string, Item>` held as
// `ReadonlyMap<string, View>`) are the class instances themselves: their
// methods dispatch as on any instance. One binding that holds a view in one
// pass and a Map of plain objects in the next reads each correctly in
// for-of, values(), forEach and spreads.
interface View {
  readonly name: string;
  label(): string;
}
class Item {
  readonly name: string;
  constructor(name: string) {
    this.name = name;
  }
  label(): string {
    return `item ${this.name}`;
  }
}
const typed = new Map<string, Item>([["a", new Item("a")], ["b", new Item("b")]]);
const plain = new Map<string, View>([["p", { name: "p", label: () => "plain p" }]]);
const sources: ReadonlyMap<string, View>[] = [typed, plain, typed, plain];
const out: string[] = [];
for (let round = 0; round < 2; round++) {
  for (const source of sources) {
    const current = source;
    for (const [key, value] of current) out.push(`${key}:${value.label()}`);
    for (const value of current.values()) out.push(value.name);
    current.forEach((value, key) => out.push(`${key}=${value.name}`));
    out.push(String([...current.values()].length));
  }
}
console.log(out.join(" "));
const only = new Map<string, Item>([["solo", new Item("solo")]]);
const onlyView: ReadonlyMap<string, View> = only;
console.log(onlyView.get("solo")!.label(), [...onlyView.values()].map((value) => value.label()).join(","));

// An array or record passed to a parameter, returned, or bound to a const
// under a type that lacks some of its optional fields stays the same value:
// identity comparisons and writes through any of the names see one object.

interface Entry {
  key: string;
  hits: number;
  note?: string;
}
type Counted = { key: string; hits: number };

function same(list: Counted[], other: Entry[]): boolean {
  return (list as unknown) === other;
}
function keep(list: Counted[]): Counted[] {
  return list;
}
function first(list: Counted[]): Counted {
  return list[0]!;
}
function grow(list: Counted[], key: string): Counted[] {
  list.push({ key, hits: 0 });
  return list;
}

const entries: Entry[] = [{ key: "a", hits: 1, note: "first" }];
console.log(same(entries, entries), keep(entries) === entries, first(entries) === entries[0]);
const grown = grow(entries, "b");
grown.push({ key: "c", hits: 2 });
console.log(grown === entries, entries.length, entries.map((e) => e.key).join(","));

function local(list: Entry[]): boolean {
  const view: Counted[] = list;
  const kept = keep(list);
  view[0]!.hits += 10;
  return view === list && kept === list;
}
console.log(local(entries), entries[0]!.hits, entries[0]!.note);

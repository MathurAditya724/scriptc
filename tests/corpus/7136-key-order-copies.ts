// Copies of object literals that write the same keys in different orders:
// spreads, spreads with other keys before and after, rest bindings,
// Object.assign and structuredClone keep each value's own order.
const a = { id: 1, name: "a", ok: true };
const b = { name: "b", ok: false, id: 2 };
const c = { ok: true, id: 3, name: "c" };
for (const value of [a, b, c]) {
  const copy = { ...value };
  const changed = { ...value, id: 10 };
  const after = { ...value, extra: "e" };
  const before = { first: 0, ...value };
  const { name, ...rest } = value;
  const assigned = Object.assign({}, value);
  const cloned = structuredClone(value);
  console.log(JSON.stringify(copy), JSON.stringify(changed));
  console.log(JSON.stringify(after), Object.keys(before).join(","));
  console.log(name, JSON.stringify(rest), Object.keys(rest).join(","));
  console.log(JSON.stringify(assigned), JSON.stringify(cloned));
}

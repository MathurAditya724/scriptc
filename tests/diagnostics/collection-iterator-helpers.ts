// Iterator helpers lower over Map/Set iterators, generators and array
// iterators. These helper forms are refused explicitly.
const set = new Set<number>([1, 2]);
// flatMap callbacks return arrays or generators.
set.values().flatMap((value) => new Set([value, value + 1]));
// return() on a helper object.
const mapped = set.values().map((value) => value * 2);
mapped.return!();
// Each helper call must produce a diagnostic.

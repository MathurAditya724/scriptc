// .groups on matchAll rows reached through array callbacks (map, forEach,
// filter, some, find) and Array.from's mapping function, with plain and
// duplicate named groups.
const text = "a1b2c3";
console.log([...text.matchAll(/(?<k>[a-z])/g)].map((m) => m.groups!.k).join(""));
console.log([...text.matchAll(/(?<k>[a-z])|(?<k>\d)/g)].map((m) => m.groups!.k).join(""));
console.log(Array.from(text.matchAll(/(?<d>\d)/g), (m) => m.groups!.d).join("+"));
const rows = [...text.matchAll(/(?<letter>[a-z])(?<digit>\d)/g)];
rows.forEach((m) => console.log(m.groups!.letter, m.groups!.digit, JSON.stringify(m.groups)));
console.log(rows.filter((m) => m.groups!.digit !== "2").length);
console.log(rows.some((m) => m.groups!.letter === "c"), rows.find((m) => m.groups!.digit === "3") !== undefined);

import { parse, stringify } from "smol-toml";

const doc = parse(`title = "demo"
answer = 42
tags = ["a", "b"]

[owner]
name = "Tom"
`);
console.log(JSON.stringify(doc));
console.log(stringify({ name: "spm", version: 1, nested: { ok: true, list: [1, 2, 3] } }));

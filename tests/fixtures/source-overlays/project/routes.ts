import { parse } from "path-to-regexp";

for (const route of ["/a/:b/(\\d+)/:c?", "/files/:dir+/:name.json", "/:lang(en|de)/docs/:rest*"]) {
  const tokens = parse(route);
  console.log(route, tokens.length);
  for (const token of tokens) {
    console.log(
      typeof token === "string"
        ? `  text ${token}`
        : `  key ${token.name} prefix=${token.prefix} pattern=${token.pattern} modifier=${token.modifier}`,
    );
  }
}
try {
  parse("/:bad(");
} catch (e) {
  console.log("error", (e as Error).message);
}

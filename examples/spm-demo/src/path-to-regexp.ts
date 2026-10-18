import { compile, match, pathToRegexp } from "path-to-regexp";

const matchUser = match<{ id: string }>("/user/:id", { decode: decodeURIComponent });
const hit = matchUser("/user/42");
console.log(hit === false ? "no match" : `${hit.path} id=${hit.params.id}`);
console.log(matchUser("/team/1") === false ? "no match" : "match");
console.log(compile<{ id: string }>("/user/:id")({ id: "7" }));
console.log(pathToRegexp("/files/:name.:ext").source);

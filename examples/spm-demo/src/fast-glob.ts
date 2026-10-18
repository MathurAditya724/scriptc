import fg from "fast-glob";

const files = fg.sync(["src/*.ts"], { cwd: process.cwd() }).sort();
console.log(files.join("\n"));

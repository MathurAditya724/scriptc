const { pathToRegexp } = require("path-to-regexp") as typeof import("path-to-regexp");

console.log(pathToRegexp("/a/:b").source);

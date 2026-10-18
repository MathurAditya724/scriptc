import semver from "semver";

console.log(semver.satisfies("1.2.3", "^1.0.0"), semver.inc("1.2.3", "minor"));

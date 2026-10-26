// Re-exports from an island package that tsconfig `paths` maps to its
// installed directory: the type-only one is erased, the value one reports
// the island boundary, and the package's declarations never compile as a
// program module. The test builds it beside corpus 6839's pathkit package.
export type { Route } from "pathkit";
export { route } from "pathkit";
console.log("loaded");

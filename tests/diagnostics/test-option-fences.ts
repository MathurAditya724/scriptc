// node:test options lower for skip, todo and only on tests and suites, and
// plan and timeout on tests. Each other option is refused with a named
// diagnostic: concurrency, a suite's timeout and plan, and a plan that is
// not a non-negative integer literal.
import { describe, test } from "node:test";

test("lowers", { plan: 1, timeout: 50 }, (t) => {
  t.assert.ok(true);
});

test("concurrency", { concurrency: 2 }, () => {});

describe("suite timeout", { timeout: 100 }, () => {});

describe("suite plan", { plan: 1 }, () => {});

const count = 2;
test("computed plan", { plan: count }, () => {});

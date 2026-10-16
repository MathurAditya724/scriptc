// node:test mocks lower for mock.fn(original[, implementation]) and
// t.mock.fn. The rest of the mock surface is refused, each with a named
// diagnostic: mock.fn() without an original, mock.method, the tracker's
// restoreAll and reset, t.mock.method, and functions whose union return
// type has no undefined arm (the calls log records undefined for calls that
// throw).
import { mock, test } from "node:test";

const add = mock.fn((a: number, b: number) => a + b); // lowers
add(1, 2);

const empty = mock.fn(); // no original function
empty();

const obj = { value: () => 1 };
mock.method(obj, "value"); // method mocks
mock.restoreAll();
mock.reset();

test("tracker methods on t.mock", (t) => {
  t.mock.method(obj, "value");
});

const pick = mock.fn((flag: boolean): number | string => (flag ? 1 : "one")); // union without undefined
pick(true);

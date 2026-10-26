// React's warning expression discards a logical tail whose conditional arms are void.
const instance = { render: null };
const Component = { prototype: { render() {} } };
instance.render || (Component.prototype && typeof Component.prototype.render === "function"
  ? console.error("missing render method")
  : console.error("invalid component"));

let checks = 0;
function check(value) { checks++; return value; }
function emit(value) { console.log(value); }
for (const left of [false, true]) {
  for (const branch of [false, true]) {
    check(left) && (check(branch) ? emit("and true") : emit("and false"));
    check(left) || (check(branch) ? emit("or true") : emit("or false"));
    left || (check(branch) && (check(!branch) ? emit("nested true") : emit("nested false")));
    left || (checks += 10, check(branch) ? emit("comma true") : emit("comma false"));
    left || (true ? (check(branch) ? emit("selected true") : emit("selected false")) : emit("skipped"));
  }
}

// Initializers and updates discard their results too.
let step = 0;
for (check(false) || (check(true) ? emit("init true") : emit("init false"));
  step < 1;
  check(true) && (check(false) ? emit("update true") : emit("update false"))) {
  step++;
}
console.log("checks", checks, "steps", step);

/**
 * @template T
 * @param {boolean} skip
 * @param {boolean} flag
 * @param {() => T} a
 * @param {() => T} b
 * @returns {void}
 */
function choose(skip, flag, a, b) { skip || (flag ? a() : b()); }
choose(false, true, () => emit("generic true"), () => emit("generic false"));
choose(false, false, () => emit("generic true"), () => emit("generic false"));
choose(true, true, () => { throw new Error("skipped"); }, () => emit("skipped"));
choose(false, true, () => 1, () => 2);
try {
  choose(false, true, () => { throw new Error("chosen"); }, () => emit("skipped"));
} catch (error) {
  console.log(error.message);
}

for (const value of ["text", 0]) {
  typeof value === "string" && (check(value.length > 0)
    ? emit(value.toUpperCase()) : emit(value.toLowerCase()));
}

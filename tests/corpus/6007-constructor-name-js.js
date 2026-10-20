// value.constructor.name in JavaScript: untyped caught errors answer the
// class that constructed them, including builtin errors whose `name` was
// reassigned, DOMException, and program error classes.
class Shape {}
class Circle extends Shape {}
class AppError extends Error {
  constructor(message) {
    super(message);
    this.name = this.constructor.name;
  }
}
class NotFound extends AppError {}

for (const s of [new Shape(), new Circle()]) console.log(s.constructor.name);

function report(error) {
  console.log(error.constructor.name, error.name, error.message);
}
try {
  throw new RangeError("range");
} catch (error) {
  report(error);
}
try {
  const e = new TypeError("type");
  e.name = "Renamed";
  throw e;
} catch (error) {
  report(error);
}
try {
  throw new DOMException("stopped", "AbortError");
} catch (error) {
  report(error);
}
try {
  throw new NotFound("missing");
} catch (error) {
  report(error);
}
try {
  JSON.parse("{");
} catch (error) {
  console.log(error.constructor.name);
}

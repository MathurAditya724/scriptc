// value.constructor.name names the class that constructed the value:
// program classes (with and without subclasses), builtin errors, program
// error classes, DOMException, and errors whose `name` was reassigned.
class Shape {
  describe(): string {
    return `${this.constructor.name} shape`;
  }
}
class Circle extends Shape {}
class Square extends Shape {}
class Lone {}

const shapes: Shape[] = [new Shape(), new Circle(), new Square()];
for (const s of shapes) console.log(s.constructor.name, s.describe());
console.log(new Lone().constructor.name);

const Anonymous = class {};
console.log(new Anonymous().constructor.name);

class AppError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}
class NotFound extends AppError {}
class Conflict extends AppError {}

const failures: AppError[] = [new AppError("a"), new NotFound("b"), new Conflict("c")];
for (const f of failures) console.log(f.constructor.name, f.name, String(f));

const errors: Error[] = [
  new Error("e"),
  new TypeError("t"),
  new RangeError("r"),
  new SyntaxError("s"),
  new URIError("u"),
  new EvalError("v"),
  new ReferenceError("f"),
  new AggregateError([], "g"),
  new NotFound("n"),
];
for (const e of errors) console.log(e.constructor.name, e.name);

const renamed = new RangeError("renamed");
renamed.name = "Custom";
console.log(renamed.constructor.name, renamed.name);

const abort = new DOMException("stopped", "AbortError");
console.log(abort.constructor.name, abort.name);

function kind(error: unknown): string {
  return error instanceof Error ? error.constructor.name : typeof error;
}
try {
  JSON.parse("{");
} catch (error) {
  console.log(kind(error));
}
try {
  throw new Conflict("thrown");
} catch (error) {
  console.log(kind(error), (error as Error).constructor.name);
}
console.log(kind("text"));

// A constructor replaced through an untyped value answers the
// replacement's name, for classes with and without subclasses.
class Replacement {}
const replaced = new Lone();
const untyped: any = replaced;
untyped.constructor = { name: "Fake" };
console.log(replaced.constructor.name);
const defined = new Lone();
Object.defineProperty(defined, "constructor", { value: Replacement });
console.log(defined.constructor.name);
const shape: Shape = new Circle();
const untypedShape: any = shape;
untypedShape.constructor = Replacement;
console.log(shape.constructor.name, new Lone().constructor.name);

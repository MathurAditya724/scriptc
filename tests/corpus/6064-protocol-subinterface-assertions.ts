// An interface that extends a class-backed protocol holds values of that
// protocol, so asserting a base-typed value to it (`type as
// TupleTypeReference`, where TupleTypeReference redeclares `getTarget():
// TupleType`) keeps the class instance: its methods run and its fields read
// as on the base type.
interface Type {
  readonly flags: number;
  getTarget(): Type | undefined;
  isTypeReference(): this is TypeReference;
  isTupleType(): this is TupleType;
}
interface ObjectType extends Type {}
interface TypeReference extends ObjectType {
  getTarget(): Type;
}
interface InterfaceType extends TypeReference {}
interface TupleType extends InterfaceType {
  readonly elementFlags: readonly number[];
  readonly fixedLength: number;
}
interface TupleTypeReference extends TypeReference {
  getTarget(): TupleType;
}
class CompilerType {
  flags: number;
  target: CompilerType | undefined;
  elementFlags: number[] = [];
  fixedLength = 0;
  constructor(flags: number, target?: CompilerType) {
    this.flags = flags;
    this.target = target;
  }
  getTarget(): CompilerType | undefined {
    return this.target;
  }
  isTypeReference(): boolean {
    return (this.flags & 4) !== 0;
  }
  isTupleType(): boolean {
    return (this.flags & 8) !== 0;
  }
}
const tuple = new CompilerType(8);
tuple.elementFlags = [1, 1, 2];
tuple.fixedLength = 2;
const reference = new CompilerType(4, tuple);
const publicType = (t: CompilerType): Type => t as unknown as Type;
function describe(type: Type): string {
  if (type.isTypeReference() && type.getTarget().isTupleType()) {
    const ref = type as TupleTypeReference;
    const target = ref.getTarget();
    return `tuple ${target.fixedLength} [${target.elementFlags.join(",")}]`;
  }
  return `flags ${type.flags}`;
}
const seen = new Set<Type>([publicType(tuple)]);
console.log(describe(publicType(reference)), describe(publicType(tuple)), seen.has(publicType(tuple)));

interface Shape {
  readonly sides: number;
  area(): number;
}
interface Square extends Shape {
  readonly side: number;
}
class SquareImpl implements Shape {
  readonly sides = 4;
  readonly side: number;
  constructor(side: number) {
    this.side = side;
  }
  area(): number {
    return this.side * this.side;
  }
}
const shapes: Shape[] = [new SquareImpl(3), new SquareImpl(5)];
for (const shape of shapes) {
  const square = shape as Square;
  console.log(square.sides, square.side, square.area(), square === shape);
}

// for await and async yield* over values held as any: a Symbol.asyncIterator
// method that returns a compiled generator, a synchronous delegate whose
// final value is a promise, and return() results that are not objects.
async function main(): Promise<void> {
  const generated: any = {
    async *[Symbol.asyncIterator]() {
      yield "a";
      yield "b";
    },
  };
  for await (const value of generated) console.log("generated", value);

  const syncGenerated: any = {
    *[Symbol.iterator]() {
      yield "x";
      yield "y";
    },
  };
  for await (const value of syncGenerated) console.log("sync generated", value);

  function* inner(): Generator<number, Promise<string>> {
    yield 1;
    return Promise.resolve("done");
  }
  async function* outer(): AsyncGenerator<number, void> {
    const result = yield* inner();
    console.log("delegate result", result);
  }
  for await (const value of outer()) console.log("delegated", value);

  const primitiveReturn: any = {
    [Symbol.asyncIterator]() {
      return {
        next: async () => ({ value: 1, done: false }),
        return: async () => 5,
      };
    },
  };
  try {
    for await (const value of primitiveReturn) {
      console.log("before break", value);
      break;
    }
    console.log("no error");
  } catch (error) {
    console.log("break", (error as Error).name, (error as Error).message);
  }

  async function* wrapper(): AsyncGenerator<unknown, void> {
    yield* primitiveReturn;
  }
  const it = wrapper();
  console.log("first", await it.next());
  try {
    console.log("returned", await it.return());
  } catch (error) {
    console.log("return", (error as Error).name, (error as Error).message);
  }
}
main();

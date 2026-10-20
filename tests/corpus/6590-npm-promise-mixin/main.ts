// execa 5's Promise mixin (lib/promise.js, MIT) over checked objects: the
// native Promise prototype's then/catch/finally read through
// `(async () => {})().constructor.prototype` and Reflect, bound to a promise
// or applied to a lazily created one, and defined onto the target, which
// `await` then adopts as a thenable. Plain thenables are adopted as well.
import { run } from 'promise-mixin';

for (const line of await run()) console.log(line);

const custom: unknown = {
  then(resolve: (value: string) => void) {
    resolve('ts thenable');
  },
};
console.log(await custom);
const plain: unknown = 42;
console.log(await plain);

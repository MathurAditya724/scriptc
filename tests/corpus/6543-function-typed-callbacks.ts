// A parameter typed with the untyped `Function` interface, as older stream
// subclasses declare their completion callback: the value is called through
// the checked-dynamic function boundary.
import { Transform } from 'node:stream';

class Prefix extends Transform {
  seen = '';
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  _transform(chunk: Buffer, _encoding: string, cb: Function) {
    this.seen += chunk.toString();
    this.push('> ' + chunk.toString());
    cb();
  }
}

const stream = new Prefix();
stream.on('data', (data: Buffer) => process.stdout.write(data.toString()));
stream.on('end', () => console.log('seen', JSON.stringify(stream.seen)));
stream.write('one\n');
stream.end('two\n');

// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
function apply(fn: Function, a: number, b: number): unknown {
  return fn(a, b);
}
console.log(apply((a: number, b: number) => a + b, 2, 3));
// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
const stored: Function = (text: string) => text.toUpperCase();
console.log(stored('x'), typeof stored);

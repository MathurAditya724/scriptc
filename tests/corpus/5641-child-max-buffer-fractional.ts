// A fractional maxBuffer: exec compares the output's length with the
// limit as a number, then keeps `maxBuffer - previous total` UTF-16 code
// units truncated to an integer, as Node's slice does. A cut with less than
// one unit left keeps nothing more, and a cut with exactly one unit left
// inside an astral character keeps its high surrogate.
import { exec } from "node:child_process";

function run(command: string, maxBuffer: number): Promise<string> {
  return new Promise((resolve) => {
    exec(command, { encoding: "utf8", maxBuffer }, (error, stdout) => {
      const code = error ? (error as { code?: string }).code : "ok";
      resolve(`${maxBuffer} ${code} ${stdout.length} ${JSON.stringify(stdout.length > 16 ? stdout.slice(-4) : stdout)}`);
    });
  });
}

async function main(): Promise<void> {
  for (const [text, max] of [
    ["abc", 2.5],
    ["abc", 0.5],
    ["abc", 2.999],
    ["abc", 3.5],
    ["a😀b", 1.5],
    ["a😀b", 2.5],
    ["a😀b", 3.5],
    ["😀", 0.5],
    ["😀", 1.5],
    ["é😀", 2.5],
  ] as [string, number][]) {
    console.log(JSON.stringify(text), await run(`printf '%s' '${text}'`, max));
  }
  // Cuts on the last character of outputs whose lengths are powers of two,
  // so some cut lands on the end of the capture buffer.
  for (let length = 1; length <= 1 << 17; length *= 2) {
    console.log("x", length, await run(`head -c ${length} /dev/zero | tr '\\0' x`, length - 0.5));
    if (length > 1) console.log("y", length, await run(`head -c ${length} /dev/zero | tr '\\0' y`, length - 1.5));
  }
}

void main();

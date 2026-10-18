import { Sema } from "async-sema";

const sema = new Sema(2);
const log: string[] = [];

async function job(id: number): Promise<void> {
  await sema.acquire();
  log.push(`start ${id}`);
  await new Promise<void>((resolve) => setTimeout(resolve, 5 * (4 - id)));
  log.push(`end ${id}`);
  sema.release();
}

await Promise.all([job(1), job(2), job(3)]);
console.log(log.join("\n"));
console.log(`waiting=${sema.nrWaiting()}`);

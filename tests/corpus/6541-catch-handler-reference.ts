// p.catch(handler) with a function value rather than an inline literal: the
// handler receives the rejection reason as `unknown`, and its result
// settles the returned promise.
async function work(fail: boolean): Promise<string> {
  if (fail) throw new Error('boom');
  return 'worked';
}

function describe(error: unknown): void {
  console.log('caught', error instanceof Error ? error.message : String(error));
}

function recover(error: unknown): string {
  return `recovered from ${error instanceof Error ? error.message : typeof error}`;
}

function report(onError: (error: unknown) => void): Promise<string | void> {
  return work(true).catch(onError);
}

async function main(): Promise<void> {
  console.log(await report(describe));
  console.log(await work(false).catch(recover));
  console.log(await work(true).catch(recover));
  await Promise.reject(42).catch(describe);
  const noArgs = (): string => 'ignored reason';
  console.log(await work(true).catch(noArgs));
  const handlers: Array<(error: unknown) => void> = [describe];
  await work(true).catch(handlers[0]!);
  const voidResult: Promise<void> = new Promise<void>((_, reject) => reject(new TypeError('typed'))).catch(
    describe,
  );
  await voidResult;
  console.log('settled');
}

await main();

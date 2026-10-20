// assert(process.send) tests whether the process has an IPC channel, as
// `if (process.send)` does. Without one, the AssertionError reports the
// call's source text and undefined as its actual value.
import assert from 'node:assert';

function requireChannel(): string {
  try {
    assert(process.send);
    return 'has channel';
  } catch (error) {
    const failure = error as assert.AssertionError;
    return `${failure.name}: ${JSON.stringify(failure.message)} actual=${String(failure.actual)}`;
  }
}

console.log(requireChannel());
try {
  assert.ok(process.disconnect, 'no channel to disconnect');
} catch (error) {
  console.log((error as Error).message);
}
if (!process.send) console.log('no send');

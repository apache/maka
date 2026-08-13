import assert from 'node:assert/strict';
import test from 'node:test';
import { releaseSessionObservation } from '../../preload/session-observation-release.js';

test('releases a Session observation before and after its queued dispatch settles', async () => {
  let settleObservation!: () => void;
  const completion = new Promise<void>((resolve) => {
    settleObservation = resolve;
  });
  let releases = 0;
  const releasing = releaseSessionObservation(Promise.resolve({ completion }), async () => {
    releases += 1;
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(releases, 1);
  settleObservation();
  await releasing;
  assert.equal(releases, 2);
});

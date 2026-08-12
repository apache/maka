import assert from 'node:assert/strict';
import { test } from 'node:test';
import { notifyWhenSeeded } from '../../preload/seed-completion.js';

test('does not notify after the subscription is disposed', async () => {
  let resolveSeed!: () => void;
  const seed = new Promise<void>((resolve) => {
    resolveSeed = resolve;
  });
  let notifications = 0;

  const dispose = notifyWhenSeeded(seed, () => {
    notifications++;
  });
  dispose();
  resolveSeed();
  await seed;
  await Promise.resolve();

  assert.equal(notifications, 0);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HostResidencyRegistry } from '../server/host-residency-registry.js';

test('Host residency registry explains liveness and drains on exact release', async () => {
  const registry = new HostResidencyRegistry();
  const execution = registry.acquire('hosted-execution');
  const firstResource = registry.acquire('runtime-resource');
  const secondResource = registry.acquire('runtime-resource');
  assert.equal(registry.activeCount, 3);
  assert.deepEqual(registry.snapshot(), [
    { label: 'hosted-execution', count: 1 },
    { label: 'runtime-resource', count: 2 },
  ]);

  let drained = false;
  const drain = registry.waitForEmpty().then(() => {
    drained = true;
  });
  firstResource.release();
  firstResource.release();
  execution.release();
  await Promise.resolve();
  assert.equal(drained, false);
  secondResource.release();
  await drain;
  assert.equal(registry.activeCount, 0);
  assert.deepEqual(registry.snapshot(), []);
});

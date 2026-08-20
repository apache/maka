import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openInteractiveUsageStoresForWrite } from '@maka/storage/usage-stores';
import {
  resolveRootControlNamespace,
  resolveStorageRoot,
  STORAGE_ROOT_MARKER_FILE,
  tryAcquireInteractiveRootOwner,
} from '@maka/storage/root-authority';
import type { ConnectionContext } from '../server/operation-dispatcher.js';
import { RuntimePolicyActivationGate } from '../server/runtime-policy-activation-gate.js';
import { HostUsagePricingCoordinator } from '../server/usage-pricing-coordinator.js';

const CONNECTION_CONTEXT: ConnectionContext = {
  hostEpoch: 'root-identity-test',
  connectionId: 'root-identity-test-connection',
  principal: 'local_os_user',
  acquireResidency: () => ({ release() {} }),
};

test('a deleted live root marker requests poison drain exactly once', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-usage-pricing-root-identity-'));
  const root = join(base, 'interactive-root');
  const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  try {
    const stores = await openInteractiveUsageStoresForWrite(owner.lease);
    let drainRequests = 0;
    const coordinator = new HostUsagePricingCoordinator(
      stores,
      () => {
        drainRequests += 1;
      },
      new RuntimePolicyActivationGate(),
    );

    await rm(join(root, STORAGE_ROOT_MARKER_FILE));
    const expected = {
      ok: false,
      error: {
        code: 'persistence_failed',
        message: 'Pricing authority persistence failed',
      },
    } as const;

    assert.deepEqual(
      await coordinator.handlers['pricing.query']({ kind: 'start' }, CONNECTION_CONTEXT),
      expected,
    );
    assert.equal(drainRequests, 1);
    assert.deepEqual(
      await coordinator.handlers['pricing.query']({ kind: 'start' }, CONNECTION_CONTEXT),
      expected,
    );
    assert.equal(drainRequests, 1);
  } finally {
    await owner.close();
    await rm(join(resolveRootControlNamespace(), capability.rootId), {
      recursive: true,
      force: true,
    });
    await rm(base, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openInteractiveArtifactStoreForWrite } from '@maka/storage/artifact-stores';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import { HostArtifactCoordinator } from '../server/artifact-coordinator.js';
import type { ConnectionContext } from '../server/operation-dispatcher.js';

const connectionContext: ConnectionContext = {
  hostEpoch: 'host-epoch-1',
  connectionId: 'connection-1',
  surface: 'desktop',
  principal: 'local_os_user',
  acquireResidency: () => ({ release: () => undefined }),
};

test('Artifact mutation failure requests Host drain and fails closed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-artifact-coordinator-'));
  const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  try {
    const store = await openInteractiveArtifactStoreForWrite(owner.lease);
    await store.recover();
    await store.create({
      id: 'artifact-1',
      sessionId: 'session-1',
      turnId: 'turn-1',
      name: 'artifact.txt',
      kind: 'file',
      content: 'durable',
      now: 1,
    });

    const metadataPath = join(root, 'artifacts', 'metadata.jsonl');
    await rm(metadataPath);
    await mkdir(metadataPath);
    let drainRequests = 0;
    const coordinator = new HostArtifactCoordinator(store, () => {
      drainRequests += 1;
    });

    assert.deepEqual(
      await coordinator.handlers['artifact.delete'](
        {
          sessionId: 'session-1',
          artifactId: 'artifact-1',
        },
        connectionContext,
      ),
      {
        ok: false,
        error: {
          code: 'persistence_failed',
          message: 'Artifact deletion could not be committed',
        },
      },
    );
    assert.equal(drainRequests, 1);
  } finally {
    await owner.close();
    await rm(root, { recursive: true, force: true });
  }
});

import { defineInteractiveRuntimeHostComposition } from '../server/host-composition.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openInteractiveDeepResearchStoreForWrite } from '@maka/storage/deep-research-authority';
import { openInteractiveExecutionStoresForWrite } from '@maka/storage/execution-stores';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import {
  connectRuntimeHost,
  RuntimeHostOperationError,
  type RuntimeHostConnection,
} from '../client/index.js';
import { RUNTIME_HOST_PROTOCOL_VERSION } from '../protocol/index.js';
import { createExecutionRuntimeHostComposition } from '../server/execution-composition.js';
import { RuntimeHostKernel } from '../server/host-kernel.js';

const PROTOCOL = {
  min: RUNTIME_HOST_PROTOCOL_VERSION,
  max: RUNTIME_HOST_PROTOCOL_VERSION,
} as const;

test('two Clients and a restarted production Host share one Deep Research projection', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-host-deep-research-uds-'));
  const root = join(base, 'interactive');
  const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  let owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  if (!owner) return;
  let host: Awaited<ReturnType<typeof RuntimeHostKernel.start>> | undefined;
  let desktop: RuntimeHostConnection | undefined;
  let tui: RuntimeHostConnection | undefined;
  try {
    const setupStores = await openInteractiveExecutionStoresForWrite(owner.lease);
    const deepResearch = await openInteractiveDeepResearchStoreForWrite(owner.lease);
    const session = await setupStores.sessionStore.create({
      cwd: root,
      backend: 'fake',
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'explore',
      labels: ['mode:deep_research'],
    });
    await deepResearch.start(
      session.id,
      'Establish one durable Host-owned research workspace',
      'standard',
      { turnId: 'turn-1', toolCallId: 'research-start' },
    );
    await deepResearch.updateChecklist(
      session.id,
      {
        itemId: 'project_entrypoints',
        status: 'in_progress',
        evidenceArtifactIds: [],
      },
      { turnId: 'turn-1', toolCallId: 'research-checklist' },
    );
    const sourceRevision = (await setupStores.sessionStore.readHeaderRecordSnapshot(session.id))
      .revision;
    deepResearch.close();

    host = await RuntimeHostKernel.start({
      owner,
      idleGraceMs: 30_000,
      composition: defineInteractiveRuntimeHostComposition(createExecutionRuntimeHostComposition),
    });
    owner = undefined;
    [desktop, tui] = await Promise.all([connect(root, 'desktop'), connect(root, 'tui')]);

    const [desktopProjection, tuiProjection] = await Promise.all([
      desktop.queryDeepResearch({ sessionId: session.id }),
      tui.queryDeepResearch({ sessionId: session.id }),
    ]);
    assert.deepEqual(tuiProjection, desktopProjection);
    assert.equal(desktopProjection.kind, 'snapshot');
    if (desktopProjection.kind !== 'snapshot') return;
    assert.equal(desktopProjection.revision, 2);
    assert.equal(desktopProjection.status, 'active');
    assert.equal(
      desktopProjection.checklist.find((item) => item.itemId === 'project_entrypoints')?.status,
      'in_progress',
    );
    await assert.rejects(
      desktop.request('session.branch.create', {
        sourceSessionId: session.id,
        targetSessionId: 'deep-research-branch',
        sourceTurnId: 'turn-1',
        expectedSourceRevision: sourceRevision,
      }),
      (error: unknown) =>
        error instanceof RuntimeHostOperationError && error.code === 'operation_unavailable',
    );

    await Promise.all([desktop.close(), tui.close()]);
    desktop = undefined;
    tui = undefined;
    await host.close();
    host = undefined;

    owner = await tryAcquireInteractiveRootOwner(capability);
    assert.ok(owner);
    if (!owner) return;
    host = await RuntimeHostKernel.start({
      owner,
      idleGraceMs: 30_000,
      composition: defineInteractiveRuntimeHostComposition(createExecutionRuntimeHostComposition),
    });
    owner = undefined;
    tui = await connect(root, 'tui');

    assert.deepEqual(await tui.queryDeepResearch({ sessionId: session.id }), desktopProjection);
  } finally {
    await Promise.allSettled([desktop?.close(), tui?.close()]);
    await host?.close().catch(() => undefined);
    await owner?.close().catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
});

async function connect(
  rootPath: string,
  surface: 'desktop' | 'tui',
): Promise<RuntimeHostConnection> {
  const result = await connectRuntimeHost({ rootPath, surface, protocol: PROTOCOL });
  assert.equal(result.kind, 'connected');
  if (result.kind !== 'connected') throw new Error('Unable to connect to Runtime Host');
  return result.connection;
}

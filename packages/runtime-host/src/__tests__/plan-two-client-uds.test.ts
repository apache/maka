import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openInteractiveExecutionStoresForWrite } from '@maka/storage/execution-stores';
import { openInteractivePlanStoreForWrite } from '@maka/storage/plan-authority';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import { connectRuntimeHost, type RuntimeHostConnection } from '../client/index.js';
import { RUNTIME_HOST_PROTOCOL_VERSION } from '../protocol/index.js';
import { createExecutionRuntimeHostComposition } from '../server/execution-composition.js';
import { RuntimeHostKernel } from '../server/host-kernel.js';

const PROTOCOL = {
  min: RUNTIME_HOST_PROTOCOL_VERSION,
  max: RUNTIME_HOST_PROTOCOL_VERSION,
} as const;

test('two UDS Clients and a restarted production Host share one retry-safe Plan authority', {
  skip: process.platform === 'win32' ? 'POSIX UDS integration' : false,
}, async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-host-plan-uds-'));
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
    const planStore = await openInteractivePlanStoreForWrite(owner.lease);
    const session = await setupStores.sessionStore.create({
      cwd: root,
      backend: 'fake',
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'explore',
      collaborationMode: 'plan',
    });
    const submitted = await planStore.submitProposal({
      operationId: 'submit-operation',
      sessionId: session.id,
      turnId: 'turn-1',
      title: 'Shared Plan',
      steps: [
        {
          id: 'step-1',
          title: 'Commit once',
          description: 'Approve one durable Plan execution',
        },
      ],
    });
    assert.equal(submitted.event.type, 'plan_submitted');
    if (submitted.event.type !== 'plan_submitted') return;
    planStore.close();

    host = await RuntimeHostKernel.start({
      owner,
      idleGraceMs: 30_000,
      compositionFactory: createExecutionRuntimeHostComposition,
    });
    owner = undefined;
    [desktop, tui] = await Promise.all([connect(root, 'desktop'), connect(root, 'tui')]);

    const first = await desktop.queryPlan({ kind: 'list_start', sessionId: session.id });
    assert.equal(first.kind, 'page');
    if (first.kind !== 'page') return;
    const approval = {
      kind: 'approve_proposal' as const,
      sessionId: session.id,
      proposalId: submitted.event.proposal.proposalId,
      expectedRevision: submitted.event.proposal.revision,
      expectedStoreVersion: first.storeVersion,
      operationId: 'approve-operation',
    };
    const approved = await desktop.controlPlan(approval);
    assert.equal(approved.eventType, 'plan_approved');
    assert.ok(approved.executionId);

    const shared = await tui.queryPlan({ kind: 'list_start', sessionId: session.id });
    assert.equal(shared.kind, 'page');
    if (shared.kind === 'page') {
      assert.equal(shared.activeExecutionId, approved.executionId);
      assert.equal(shared.items.filter((item) => item.kind === 'execution').length, 1);
    }

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
      compositionFactory: createExecutionRuntimeHostComposition,
    });
    owner = undefined;
    tui = await connect(root, 'tui');

    const replayed = await tui.controlPlan(approval);
    assert.equal(replayed.executionId, approved.executionId);
    assert.equal(replayed.storeVersion, approved.storeVersion);
    const recovered = await tui.queryPlan({ kind: 'list_start', sessionId: session.id });
    assert.equal(recovered.kind, 'page');
    if (recovered.kind !== 'page') return;
    assert.equal(recovered.activeExecutionId, null);
    const execution = recovered.items.find((item) => item.kind === 'execution');
    assert.ok(execution && execution.kind === 'execution');
    if (!execution || execution.kind !== 'execution') return;
    assert.equal(execution.execution.status, 'interrupted');

    const cancelled = await tui.controlPlan({
      kind: 'cancel_execution',
      sessionId: session.id,
      executionId: execution.execution.executionId,
      operationId: 'cancel-operation',
    });
    assert.equal(cancelled.eventType, 'plan_execution_cancelled');
    assert.equal(cancelled.storeVersion, approved.storeVersion + 2);
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

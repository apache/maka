import { defineInteractiveRuntimeHostComposition } from '../server/host-composition.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openInteractiveExecutionStoresForWrite } from '@maka/storage/execution-stores';
import { openInteractivePlanStoreForWrite } from '@maka/storage/plan-authority';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import {
  connectRuntimeHost,
  type RuntimeHostConnection,
  type RuntimeHostSessionSubscription,
} from '../client/index.js';
import { RUNTIME_HOST_PROTOCOL_VERSION, type SubscriptionFrame } from '../protocol/index.js';
import { createExecutionRuntimeHostComposition } from '../server/execution-composition.js';
import { RuntimeHostKernel } from '../server/host-kernel.js';

const PROTOCOL = {
  min: RUNTIME_HOST_PROTOCOL_VERSION,
  max: RUNTIME_HOST_PROTOCOL_VERSION,
} as const;

test('two Clients and a restarted production Host share one retry-safe Plan authority', async () => {
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
      composition: defineInteractiveRuntimeHostComposition(createExecutionRuntimeHostComposition),
    });
    owner = undefined;
    [desktop, tui] = await Promise.all([connect(root, 'desktop'), connect(root, 'tui')]);
    const subscription = await desktop.openSessionSubscription({
      sessionId: session.id,
      transcript: { kind: 'none' },
    });

    const first = await desktop.queryPlan({ kind: 'list_start', sessionId: session.id });
    assert.equal(first.kind, 'page');
    if (first.kind !== 'page') return;
    const approval = {
      kind: 'approve_proposal' as const,
      sessionId: session.id,
      proposalId: submitted.event.proposal.proposalId,
      expectedRevision: submitted.event.proposal.revision,
      expectedStoreVersion: first.storeVersion,
      turnId: 'approve-turn',
    };
    const started = await tui.startPlanTurn(approval);
    const approved = started.plan;
    assert.equal(approved.eventType, 'plan_approved');
    assert.ok(approved.executionId);
    assert.equal(started.turn.turnId, approval.turnId);
    const changed = await withTimeout(
      nextFrameOfKind(subscription, 'subscription.session_domain_changed'),
      2_000,
      'Plan invalidation did not reach the other Client',
    );
    assert.equal(changed.sessionId, session.id);
    assert.equal(changed.domain, 'plan');

    const shared = await tui.queryPlan({ kind: 'list_start', sessionId: session.id });
    assert.equal(shared.kind, 'page');
    if (shared.kind === 'page') {
      assert.equal(shared.activeExecutionId, approved.executionId);
      assert.equal(shared.items.filter((item) => item.kind === 'execution').length, 1);
    }

    await subscription.close();
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

    const replayed = await tui.startPlanTurn(approval);
    assert.equal(replayed.plan.executionId, approved.executionId);
    assert.equal(replayed.plan.storeVersion, approved.storeVersion);
    assert.equal(replayed.turn.turnId, approval.turnId);
    const recovered = await tui.queryPlan({ kind: 'list_start', sessionId: session.id });
    assert.equal(recovered.kind, 'page');
    if (recovered.kind !== 'page') return;
    assert.equal(recovered.activeExecutionId, null);
    const execution = recovered.items.find((item) => item.kind === 'execution');
    assert.ok(execution && execution.kind === 'execution');
    if (!execution || execution.kind !== 'execution') return;
    assert.equal(execution.execution.status, 'interrupted');

    await assert.rejects(
      tui.startPlanTurn({
        kind: 'resume_execution',
        sessionId: session.id,
        executionId: execution.execution.executionId,
        turnId: approval.turnId,
      }),
      (error: unknown) =>
        error instanceof Error && 'code' in error && error.code === 'operation_conflict',
    );
    const unchanged = await tui.queryPlan({ kind: 'list_start', sessionId: session.id });
    assert.equal(unchanged.kind, 'page');
    assert.equal(
      unchanged.kind === 'page'
        ? unchanged.items.find((item) => item.kind === 'execution')?.execution.status
        : undefined,
      'interrupted',
    );

    const resumed = await tui.startPlanTurn({
      kind: 'resume_execution',
      sessionId: session.id,
      executionId: execution.execution.executionId,
      turnId: 'resume-turn',
    });
    assert.equal(resumed.plan.eventType, 'plan_execution_resumed');
    assert.equal(resumed.plan.executionId, execution.execution.executionId);
    assert.equal(resumed.turn.turnId, 'resume-turn');
    await waitForTerminal(tui, resumed.turn);
    const afterResume = await tui.queryPlan({ kind: 'list_start', sessionId: session.id });
    assert.equal(afterResume.kind, 'page');
    assert.equal(
      afterResume.kind === 'page' ? afterResume.activeExecutionId : undefined,
      execution.execution.executionId,
    );
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

async function waitForTerminal(
  connection: RuntimeHostConnection,
  initial: Awaited<ReturnType<RuntimeHostConnection['startPlanTurn']>>['turn'],
): Promise<void> {
  let snapshot = initial;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (
      snapshot.status === 'completed' ||
      snapshot.status === 'failed' ||
      snapshot.status === 'cancelled'
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    snapshot = await connection.queryTurn({
      sessionId: snapshot.sessionId,
      turnId: snapshot.turnId,
    });
  }
  throw new Error('Plan execution Turn did not settle');
}

async function nextFrameOfKind<K extends SubscriptionFrame['kind']>(
  subscription: RuntimeHostSessionSubscription,
  kind: K,
): Promise<Extract<SubscriptionFrame, { kind: K }>> {
  for await (const frame of subscription) {
    if (frame.kind === kind) {
      return frame as Extract<SubscriptionFrame, { kind: K }>;
    }
  }
  throw new Error(`Session subscription ended before ${kind}`);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

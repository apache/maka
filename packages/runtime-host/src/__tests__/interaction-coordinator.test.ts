import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { UserQuestionRequestEvent } from '@maka/core/events';
import {
  RuntimeInteractionAdmissionRejectedError,
  RuntimeInteractionFailStopError,
  type RuntimeInteractionRunIdentity,
  type RuntimeUserQuestionContinuation,
} from '@maka/runtime';
import {
  openSqliteInteractiveInteractionStoreForWrite,
  type InteractiveInteractionStoreWriterFacade,
  type StoredInteractionRequest,
} from '@maka/storage/interaction-store';
import {
  resolveStorageRoot,
  tryAcquireInteractiveRootOwner,
  type InteractiveRootOwner,
} from '@maka/storage/root-authority';
import type { SessionInteractionProjection } from '../protocol/index.js';
import type { ConnectionContext } from '../server/operation-dispatcher.js';
import {
  HostInteractionCoordinator,
  type HostInteractionCoordinatorOptions,
} from '../server/interaction-coordinator.js';
import { SessionAdmissionGate } from '../server/session-admission-gate.js';

const RUN = Object.freeze({
  sessionId: 'session_1',
  turnId: 'turn_1',
  runId: 'run_1',
});

describe('HostInteractionCoordinator', () => {
  test('admits a durable question before continuity and returns one canonical answer to concurrent clients', async () => {
    await withStore(async ({ store }) => {
      const order: string[] = [];
      const continuation = questionContinuation('question_1', {
        answer: (answers) => order.push(`apply:${answers.join(',')}`),
      });
      const coordinator = createCoordinator(store, {
        preflightSessionSnapshot: async (_sessionId, projection) => {
          order.push('preflight');
          assert.equal(projection.pending.length, 1);
          assert.equal(await store.readInteraction('question_1'), undefined);
          return true;
        },
        refreshCanonicalContinuity: async () => {
          const record = await store.readInteraction('question_1');
          order.push(record?.outcome ? 'refresh:answered' : 'refresh:pending');
        },
      });
      const owner = coordinator.bindRun(RUN);

      await owner.acceptUserQuestionRequest({
        request: questionEvent('question_1', 10),
        continuation,
      });
      assert.deepEqual(order, ['preflight', 'refresh:pending']);

      const answer = {
        interactionId: 'question_1',
        answer: { kind: 'question', answers: ['Yes'] },
      } as const;
      const [first, second] = await Promise.all([
        coordinator.handlers['interaction.answer'](answer, connection()),
        coordinator.handlers['interaction.answer'](answer, connection()),
      ]);
      assert.equal(first.ok, true);
      assert.equal(second.ok, true);
      assert.deepEqual(order, ['preflight', 'refresh:pending', 'refresh:answered', 'apply:Yes']);

      const conflicting = await coordinator.handlers['interaction.answer'](
        {
          interactionId: 'question_1',
          answer: { kind: 'question', answers: ['No'] },
        },
        connection(),
      );
      assert.equal(conflicting.ok, false);
      if (!conflicting.ok) assert.equal(conflicting.error.code, 'already_resolved');

      await owner.close('turn_terminal');
      owner.release();
      await coordinator.close();
    });
  });

  test('retains the exact live continuation and poisons when async apply rejects', async () => {
    await withStore(async ({ store }) => {
      const poison: RuntimeInteractionFailStopError[] = [];
      let applyCount = 0;
      const coordinator = createCoordinator(store, {
        onPoison: (error) => poison.push(error),
      });
      const owner = coordinator.bindRun(RUN);
      await owner.acceptUserQuestionRequest({
        request: questionEvent('question_rejected_apply', 10),
        continuation: questionContinuation('question_rejected_apply', {
          answer: async () => {
            applyCount += 1;
            throw new Error('local waiter rejected');
          },
        }),
      });

      await assert.rejects(
        coordinator.handlers['interaction.answer'](
          {
            interactionId: 'question_rejected_apply',
            answer: { kind: 'question', answers: ['Yes'] },
          },
          connection(),
        ),
        RuntimeInteractionFailStopError,
      );
      const record = await store.readInteraction('question_rejected_apply');
      assert.equal(record?.outcome?.outcome.kind, 'question_answer');
      assert.equal(applyCount, 1);
      assert.equal(coordinator.isPoisoned(), true);
      assert.equal(poison.length, 1);
      await assert.rejects(owner.close('turn_terminal'), poison[0]);
      await assert.rejects(coordinator.close(), poison[0]);
    });
  });

  test('closes a Run durably before local continuation and recovers orphaned pending requests', async () => {
    await withStore(async ({ store }) => {
      const order: string[] = [];
      const coordinator = createCoordinator(store, {
        refreshCanonicalContinuity: async () => {
          const record = await store.readInteraction('question_close');
          const outcome = record?.outcome?.outcome;
          order.push(outcome?.kind === 'closure' ? `refresh:${outcome.reason}` : 'refresh:pending');
        },
      });
      const owner = coordinator.bindRun(RUN);
      await owner.acceptUserQuestionRequest({
        request: questionEvent('question_close', 10),
        continuation: questionContinuation('question_close', {
          closure: (reason) => order.push(`apply:${reason}`),
        }),
      });
      order.length = 0;

      await owner.close('turn_stopped');
      assert.deepEqual(order, ['refresh:turn_stopped', 'apply:turn_stopped']);
      owner.release();
      await coordinator.close();
    });

    await withStore(async ({ store }) => {
      const orphan = storedQuestion('question_orphan', RUN, 15);
      assert.equal((await store.establishRequest(orphan)).status, 'stable');
      const order: string[] = [];
      const coordinator = createCoordinator(store, {
        refreshCanonicalContinuity: async () => {
          const record = await store.readInteraction(orphan.requestId);
          const outcome = record?.outcome?.outcome;
          order.push(outcome?.kind === 'closure' ? `refresh:${outcome.reason}` : 'refresh:pending');
        },
      });

      await coordinator.recoverPendingAfterHostRestart();
      assert.deepEqual(order, ['refresh:host_restarted']);
      assert.deepEqual(await store.listPending(), []);
      await coordinator.close();
    });
  });

  test('closes pending legacy permission requests after upgrade without rewriting settled history', async () => {
    await withStore(async ({ store }) => {
      const pendingAdditional = storedLegacyAdditionalPermission(
        'legacy_additional_pending',
        RUN,
        10,
      );
      const pendingEscalation = storedLegacySandboxEscalation('legacy_escalation_pending', RUN, 20);
      const settled = storedLegacyAdditionalPermission('legacy_additional_settled', RUN, 30);
      for (const request of [pendingAdditional, pendingEscalation, settled]) {
        assert.equal((await store.establishRequest(request)).status, 'stable');
      }
      const settledOutcome = {
        kind: 'permission_answer',
        decision: 'deny',
        rememberForTurn: false,
        reviewer: 'user',
        committedAt: 90,
      } as const;
      assert.equal((await store.commitOutcome(settled.requestId, settledOutcome)).status, 'stable');

      const coordinator = createCoordinator(store);
      await coordinator.recoverPendingAfterHostRestart();

      for (const [requestId, committedAt] of [
        [pendingAdditional.requestId, 101],
        [pendingEscalation.requestId, 102],
      ] as const) {
        assert.deepEqual((await store.readInteraction(requestId))?.outcome?.outcome, {
          kind: 'closure',
          reason: 'host_restarted',
          committedAt,
        });
      }
      assert.deepEqual(
        (await store.readInteraction(settled.requestId))?.outcome?.outcome,
        settledOutcome,
      );
      assert.deepEqual(await store.listPending(), []);
      await coordinator.close();
    });
  });

  test('drain permits only an exact Run preclaimed by its stop closure to bind', async () => {
    await withStore(async ({ store }) => {
      const gate = new SessionAdmissionGate();
      const coordinator = createCoordinator(store, { sessionAdmission: gate });
      coordinator.beginDrain();

      await gate.run(RUN.sessionId, (admission) =>
        coordinator.claimRunClosure(RUN, 'turn_stopped', admission),
      );
      const owner = coordinator.bindRun(RUN);
      await assert.rejects(
        Promise.resolve().then(() =>
          coordinator.bindRun({
            sessionId: RUN.sessionId,
            turnId: 'turn_unclaimed',
            runId: 'run_unclaimed',
          }),
        ),
        (error: unknown) =>
          error instanceof RuntimeInteractionAdmissionRejectedError &&
          error.reason === 'authority_draining',
      );

      await owner.close('turn_stopped');
      owner.release();
      await coordinator.close();
    });
  });

  test('close reaps a settled unbound closure-only Run without poisoning', async () => {
    await withStore(async ({ store }) => {
      const poison: RuntimeInteractionFailStopError[] = [];
      const gate = new SessionAdmissionGate();
      const coordinator = createCoordinator(store, {
        sessionAdmission: gate,
        onPoison: (error) => poison.push(error),
      });
      coordinator.beginDrain();

      await gate.run(RUN.sessionId, (admission) =>
        coordinator.claimRunClosure(RUN, 'turn_stopped', admission),
      );
      await coordinator.close();

      assert.equal(coordinator.isPoisoned(), false);
      assert.deepEqual(poison, []);
      assert.deepEqual(await store.listPending(RUN), []);
    });
  });

  test('terminal fence reaps an exact settled unbound closure-only Run', async () => {
    await withStore(async ({ store }) => {
      const poison: RuntimeInteractionFailStopError[] = [];
      const gate = new SessionAdmissionGate();
      const coordinator = createCoordinator(store, {
        sessionAdmission: gate,
        onPoison: (error) => poison.push(error),
      });
      coordinator.beginDrain();

      await gate.run(RUN.sessionId, (admission) =>
        coordinator.claimRunClosure(RUN, 'turn_stopped', admission),
      );
      await gate.run(RUN.sessionId, (admission) => coordinator.assertTerminalFence(RUN, admission));

      assert.equal(coordinator.isPoisoned(), false);
      assert.deepEqual(poison, []);
      assert.deepEqual(await store.listPending(RUN), []);
      await coordinator.close();
    });
  });

  test('close fails closed while an unbound closure claim is unsettled', async () => {
    await withStore(async ({ store }) => {
      const poison: RuntimeInteractionFailStopError[] = [];
      const refreshStarted = deferred();
      const releaseRefresh = deferred();
      const gate = new SessionAdmissionGate();
      const coordinator = createCoordinator(store, {
        sessionAdmission: gate,
        refreshCanonicalContinuity: async () => {
          refreshStarted.resolve();
          await releaseRefresh.promise;
        },
        onPoison: (error) => poison.push(error),
      });
      coordinator.beginDrain();

      const claim = gate.run(RUN.sessionId, (admission) =>
        coordinator.claimRunClosure(RUN, 'turn_stopped', admission),
      );
      await refreshStarted.promise;
      await assert.rejects(coordinator.close(), RuntimeInteractionFailStopError);
      assert.equal(coordinator.isPoisoned(), true);
      assert.equal(poison.length, 1);

      releaseRefresh.resolve();
      await assert.rejects(claim, poison[0]);
    });
  });

  test('terminal fence poisons on an exact Run pending record from the authentic Store', async () => {
    await withStore(async ({ store }) => {
      const poison: RuntimeInteractionFailStopError[] = [];
      const gate = new SessionAdmissionGate();
      const coordinator = createCoordinator(store, {
        sessionAdmission: gate,
        onPoison: (error) => poison.push(error),
      });
      const owner = coordinator.bindRun(RUN);
      await owner.close('turn_terminal');
      owner.release();

      const orphan = storedQuestion('question_fence', RUN, 30);
      assert.equal((await store.establishRequest(orphan)).status, 'stable');
      await assert.rejects(
        gate.run(RUN.sessionId, (admission) => coordinator.assertTerminalFence(RUN, admission)),
        RuntimeInteractionFailStopError,
      );
      assert.equal(coordinator.isPoisoned(), true);
      assert.equal(poison.length, 1);
      await assert.rejects(coordinator.close(), poison[0]);
      assert.deepEqual(await store.listPending(RUN), [orphan]);
    });
  });
});

function createCoordinator(
  store: InteractiveInteractionStoreWriterFacade,
  overrides: Partial<HostInteractionCoordinatorOptions> = {},
): HostInteractionCoordinator {
  let now = 100;
  return new HostInteractionCoordinator({
    store,
    sessionAdmission: new SessionAdmissionGate(),
    now: () => ++now,
    preflightSessionSnapshot: () => true,
    refreshCanonicalContinuity: async () => {},
    onPoison: () => {},
    ...overrides,
  });
}

function questionEvent(requestId: string, ts: number): UserQuestionRequestEvent {
  return {
    id: `event_${requestId}`,
    type: 'user_question_request',
    turnId: RUN.turnId,
    ts,
    requestId,
    toolUseId: `tool_${requestId}`,
    questions: [
      {
        question: 'Continue?',
        options: [{ label: 'Yes' }, { label: 'No' }],
      },
    ],
  };
}

function questionContinuation(
  requestId: string,
  callbacks: {
    answer?: (answers: readonly (string | null)[]) => unknown;
    closure?: (reason: Parameters<RuntimeUserQuestionContinuation['applyClosure']>[0]) => unknown;
  } = {},
): RuntimeUserQuestionContinuation {
  return {
    ...RUN,
    requestId,
    applyAnswer: async (answer) => {
      await callbacks.answer?.(answer.answers);
    },
    applyClosure: async (reason) => {
      await callbacks.closure?.(reason);
    },
  };
}

function storedQuestion(
  requestId: string,
  identity: RuntimeInteractionRunIdentity,
  createdAt: number,
): StoredInteractionRequest {
  return {
    ...identity,
    requestId,
    createdAt,
    request: {
      kind: 'question',
      toolUseId: `tool_${requestId}`,
      questions: [
        {
          question: 'Continue?',
          options: [{ label: 'Yes' }, { label: 'No' }],
        },
      ],
    },
  };
}

function storedLegacyAdditionalPermission(
  requestId: string,
  identity: RuntimeInteractionRunIdentity,
  createdAt: number,
): StoredInteractionRequest {
  return {
    ...identity,
    requestId,
    createdAt,
    request: {
      kind: 'permission',
      toolUseId: `tool_${requestId}`,
      prompt: {
        kind: 'additional_permissions',
        toolName: 'Write',
        category: 'file_write',
        reason: 'additional_permissions',
        review: {
          kind: 'additional_permissions',
          cwd: '/repo',
          paths: [{ path: '/outside/file', access: 'write', scope: 'exact' }],
          networkEnabled: true,
        },
        risk: {
          outsideWorkspace: true,
          protectedMetadata: false,
          networkEnabled: true,
        },
        alsoApprovesToolExecution: true,
        availableDecisions: ['allow_once', 'deny'],
      },
    },
  };
}

function storedLegacySandboxEscalation(
  requestId: string,
  identity: RuntimeInteractionRunIdentity,
  createdAt: number,
): StoredInteractionRequest {
  return {
    ...identity,
    requestId,
    createdAt,
    request: {
      kind: 'permission',
      toolUseId: `tool_${requestId}`,
      prompt: {
        kind: 'sandbox_escalation',
        toolName: 'Bash',
        category: 'privileged',
        reason: 'sandbox_escalation',
        review: {
          kind: 'command',
          command: 'sudo true',
          cwd: '/repo',
        },
        trigger: 'proactive',
        risk: {
          unsandboxedExecution: true,
          unrestrictedFileSystem: true,
          unrestrictedNetwork: true,
          protectedMetadataExposed: true,
        },
        alsoApprovesToolExecution: true,
        availableDecisions: ['allow_once', 'deny'],
      },
    },
  };
}

function connection(): ConnectionContext {
  return {
    hostEpoch: 'host_epoch_1',
    connectionId: 'connection_1',
    surface: 'desktop',
    principal: 'local_os_user',
    acquireResidency: () => ({ release: () => {} }),
  };
}

interface StoreContext {
  readonly owner: InteractiveRootOwner;
  readonly store: InteractiveInteractionStoreWriterFacade;
}

async function withStore(run: (context: StoreContext) => Promise<void>): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'maka-interaction-coordinator-'));
  const root = join(base, 'root');
  await mkdir(root);
  const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  if (!owner) return;
  const store = await openSqliteInteractiveInteractionStoreForWrite(owner.lease);
  try {
    await run({ owner, store });
  } finally {
    if (!owner.closed) await owner.close();
    await rm(owner.controlDirectory, { recursive: true, force: true });
    await rm(base, { recursive: true, force: true });
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

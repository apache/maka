import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { AnyPermissionRequestEvent, UserQuestionRequestEvent } from '@maka/core/events';
import {
  RuntimeInteractionAdmissionRejectedError,
  RuntimeInteractionFailStopError,
  type RuntimeInteractionRunIdentity,
  type RuntimePermissionContinuation,
  type RuntimeUserQuestionContinuation,
} from '@maka/runtime';
import {
  openInteractiveInteractionStoreForWrite,
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

  test('durably resolves all remembered permission siblings before one refresh and ordered apply', async () => {
    await withStore(async ({ store }) => {
      const order: string[] = [];
      const winnerRefreshStarted = deferred();
      const releaseWinnerRefresh = deferred();
      const coordinator = createCoordinator(store, {
        refreshCanonicalContinuity: async () => {
          const pending = await store.listPending({ sessionId: RUN.sessionId });
          order.push(`refresh:${pending.length}`);
          if (pending.length === 0) {
            winnerRefreshStarted.resolve();
            await releaseWinnerRefresh.promise;
          }
        },
      });
      const owner = coordinator.bindRun(RUN);
      const later = permissionContinuation('permission_later', order);
      const earlier = permissionContinuation('permission_earlier', order);

      await owner.acceptPermissionRequest({
        request: permissionEvent('permission_later', 'tool_later', 20),
        rememberScopeId: 'a'.repeat(64),
        continuation: later,
      });
      await owner.acceptPermissionRequest({
        request: permissionEvent('permission_earlier', 'tool_earlier', 10),
        rememberScopeId: 'a'.repeat(64),
        continuation: earlier,
      });
      order.length = 0;

      const wireWinner = coordinator.handlers['interaction.answer'](
        {
          interactionId: 'permission_later',
          answer: { kind: 'permission', decision: 'allow', rememberForTurn: true },
        },
        connection(),
      );
      await winnerRefreshStarted.promise;
      const lateTimeout = owner.commitPermissionTimeout({ continuation: later });
      releaseWinnerRefresh.resolve();
      const [result, timeoutOutcome] = await Promise.all([wireWinner, lateTimeout]);
      assert.equal(result.ok, true);
      assert.deepEqual(timeoutOutcome, {
        kind: 'permission_answer',
        answer: {
          decision: 'allow',
          rememberForTurn: true,
          reviewer: 'user',
        },
      });
      assert.equal(coordinator.isPoisoned(), false);
      assert.deepEqual(order, [
        'refresh:0',
        'apply:permission_earlier:allow:true',
        'apply:permission_later:allow:true',
      ]);
      const [first, second] = await Promise.all([
        store.readInteraction('permission_earlier'),
        store.readInteraction('permission_later'),
      ]);
      assert.equal(first?.outcome?.outcome.kind, 'permission_answer');
      assert.equal(second?.outcome?.outcome.kind, 'permission_answer');

      await owner.close('turn_terminal');
      owner.release();
      await coordinator.close();
    });
  });

  test('settles a late remembered permission sibling durably without publishing it', async () => {
    await withStore(async ({ store }) => {
      const order: string[] = [];
      const projections: SessionInteractionProjection[] = [];
      const coordinator = createCoordinator(store, {
        preflightSessionSnapshot: (_sessionId, projection) => {
          projections.push(projection);
          return true;
        },
        refreshCanonicalContinuity: async () => {
          const pending = await store.listPending({ sessionId: RUN.sessionId });
          order.push(`refresh:${pending.map((request) => request.requestId).join(',')}`);
        },
      });
      const owner = coordinator.bindRun(RUN);
      const scope = 'b'.repeat(64);

      const winnerAdmission = await owner.acceptPermissionRequest({
        request: permissionEvent('permission_winner', 'tool_winner', 10),
        rememberScopeId: scope,
        continuation: permissionContinuation('permission_winner', order),
      });
      assert.deepEqual(winnerAdmission, { state: 'pending' });
      const winner = await coordinator.handlers['interaction.answer'](
        {
          interactionId: 'permission_winner',
          answer: { kind: 'permission', decision: 'allow', rememberForTurn: true },
        },
        connection(),
      );
      assert.equal(winner.ok, true);

      const lateAdmission = await owner.acceptPermissionRequest({
        request: permissionEvent('permission_late', 'tool_late', 20),
        rememberScopeId: scope,
        continuation: permissionContinuation('permission_late', order),
      });
      assert.deepEqual(lateAdmission, { state: 'settled' });

      const [winnerRecord, lateRecord, pending] = await Promise.all([
        store.readInteraction('permission_winner'),
        store.readInteraction('permission_late'),
        store.listPending({ sessionId: RUN.sessionId }),
      ]);
      assert.equal(winnerRecord?.request.requestId, 'permission_winner');
      assert.equal(lateRecord?.request.requestId, 'permission_late');
      assert.deepEqual(lateRecord?.outcome?.outcome, winnerRecord?.outcome?.outcome);
      assert.deepEqual(pending, []);
      assert.deepEqual(
        projections.map((projection) => projection.pending.length),
        [1],
      );
      assert.deepEqual(order, [
        'refresh:permission_winner',
        'refresh:',
        'apply:permission_winner:allow:true',
        'refresh:',
        'apply:permission_late:allow:true',
      ]);

      await owner.close('turn_terminal');
      owner.release();
      await coordinator.close();
    });
  });

  test('rejects a one-shot permission remember scope before durable admission', async () => {
    await withStore(async ({ store }) => {
      const coordinator = createCoordinator(store);
      const owner = coordinator.bindRun(RUN);
      const request: AnyPermissionRequestEvent = {
        id: 'event_permission_one_shot',
        type: 'permission_request',
        turnId: RUN.turnId,
        ts: 30,
        kind: 'additional_permissions',
        requestId: 'permission_one_shot',
        toolUseId: 'tool_one_shot',
        toolName: 'Write',
        category: 'file_write',
        reason: 'additional_permissions',
        additionalPermissions: {
          fileSystem: {
            entries: [{ path: '/outside/file', access: 'write', scope: 'exact' }],
          },
        },
        cwd: '/repo',
        justification: 'Write the requested file',
        intentHash: 'intent_hash',
        permissionsHash: 'permissions_hash',
        risk: {
          outsideWorkspace: true,
          protectedMetadata: false,
          networkEnabled: false,
        },
        alsoApprovesToolExecution: true,
        availableDecisions: ['allow_once', 'deny'],
        args: undefined,
      };

      await assert.rejects(
        owner.acceptPermissionRequest({
          request,
          rememberScopeId: 'c'.repeat(64),
          continuation: permissionContinuation(request.requestId, []),
        }),
        (error: unknown) =>
          error instanceof RuntimeInteractionAdmissionRejectedError &&
          error.reason === 'invalid_request',
      );
      assert.equal(await store.readInteraction(request.requestId), undefined);
      assert.deepEqual(await store.listPending({ sessionId: RUN.sessionId }), []);
      assert.equal(coordinator.isPoisoned(), false);

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

function permissionEvent(
  requestId: string,
  toolUseId: string,
  ts: number,
): AnyPermissionRequestEvent {
  return {
    id: `event_${requestId}`,
    type: 'permission_request',
    turnId: RUN.turnId,
    ts,
    kind: 'tool_permission',
    requestId,
    toolUseId,
    toolName: 'Bash',
    category: 'shell_unsafe',
    reason: 'shell_dangerous',
    args: { command: 'echo okay', cwd: '/repo' },
    rememberForTurnAllowed: true,
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

function permissionContinuation(requestId: string, order: string[]): RuntimePermissionContinuation {
  return {
    ...RUN,
    requestId,
    applyAnswer: async (answer) => {
      order.push(
        `apply:${requestId}:${answer.decision}:${String(answer.rememberForTurn ?? false)}`,
      );
    },
    applyClosure: async (reason) => {
      order.push(`apply:${requestId}:${reason}`);
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
  const store = await openInteractiveInteractionStoreForWrite(owner.lease);
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

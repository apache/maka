import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { SandboxBoundaryRequest } from '@maka/core/sandbox-boundary';
import type { SandboxBoundaryRequestEvent, UserQuestionRequestEvent } from '@maka/core/events';
import {
  bindRuntimeInteractionRun,
  RuntimeInteractionAdmissionRejectedError,
  RuntimeInteractionFailStopError,
  type RuntimeInteractionRunIdentity,
  type RuntimeSandboxBoundaryContinuation,
  type RuntimeUserQuestionContinuation,
} from '@maka/runtime/interaction-authority';
import {
  openInteractiveExecutionStoresForWrite,
  type ExecutionStoresWriter,
} from '@maka/storage/execution-stores';
import {
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
      assert.equal(await coordinator.hasPendingSession(RUN.sessionId), true);

      const answer = {
        sessionId: RUN.sessionId,
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
      assert.equal(await coordinator.hasPendingSession(RUN.sessionId), false);

      const conflicting = await coordinator.handlers['interaction.answer'](
        {
          sessionId: RUN.sessionId,
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

  test('settles a sandbox boundary once through the canonical boundary Store and wakes its graph', async () => {
    await withStore(async ({ owner, store, stores }) => {
      const workspace = join(owner.capability.canonicalPath, 'workspace');
      await mkdir(workspace);
      const session = await stores.sessionStore.create({
        cwd: workspace,
        backend: 'fake',
        llmConnectionSlug: 'fake',
        model: 'fake-model',
        permissionMode: 'ask',
      });
      const identity = { ...RUN, sessionId: session.id };
      const requestId = 'boundary_1';
      const expansion = { network: { enabled: true as const } };
      const candidate: SandboxBoundaryRequest = {
        sessionId: session.id,
        requestId,
        status: 'pending',
        baseRevision: 0,
        turnId: identity.turnId,
        runId: identity.runId,
        expansion,
        justification: 'Read the selected file.',
        createdAt: 1,
      };
      const applied: string[] = [];
      let graphWakes = 0;
      const coordinator = new HostInteractionCoordinator({
        store,
        sandboxBoundaries: stores.sessionStore,
        sessionAdmission: new SessionAdmissionGate(),
        sessions: stores.sessionStore,
        preflightSessionSnapshot: (_sessionId, projection) => {
          assert.equal(projection.pending.length, 1);
          assert.equal(projection.pending[0]?.request.kind, 'sandbox_boundary');
          return true;
        },
        refreshCanonicalContinuity: async () => {},
        onSandboxBoundarySettled: async (sessionId) => {
          assert.equal(sessionId, session.id);
          graphWakes += 1;
        },
        onPoison: () => {},
      });
      const ownerRun = coordinator.bindRun(identity);
      assert.equal(
        await stores.sessionStore.readSandboxBoundaryRequest(session.id, requestId),
        undefined,
      );
      await ownerRun.acceptSandboxBoundaryRequest({
        request: sandboxBoundaryEvent(candidate),
        continuation: sandboxBoundaryContinuation(identity, requestId, {
          decision: (status) => applied.push(status),
        }),
      });

      const pending = await coordinator.handlers['interaction.query'](
        { sessionId: session.id, interactionId: requestId },
        connection(),
      );
      assert.equal(pending.ok, true);
      if (!pending.ok) return;
      assert.equal(pending.result.status, 'pending');
      assert.equal(pending.result.request.kind, 'sandbox_boundary');

      const answer = {
        sessionId: session.id,
        interactionId: requestId,
        answer: { kind: 'sandbox_boundary', decision: 'allow' },
      } as const;
      const [first, second] = await Promise.all([
        coordinator.handlers['interaction.answer'](answer, connection()),
        coordinator.handlers['interaction.answer'](answer, connection()),
      ]);
      assert.equal(first.ok, true);
      assert.equal(second.ok, true);
      if (!first.ok || !second.ok) return;
      assert.deepEqual(first.result, second.result);
      assert.equal(first.result.status, 'answered');
      assert.equal(first.result.outcome.kind, 'sandbox_boundary_decision');
      assert.deepEqual(applied, ['approved']);
      assert.equal(graphWakes, 1);
      assert.equal((await stores.sessionStore.readExecutionBoundary(session.id)).revision, 1);
      assert.equal(await coordinator.hasPendingSession(session.id), false);

      const closingRequest: SandboxBoundaryRequest = {
        sessionId: session.id,
        requestId: 'boundary_closing',
        status: 'pending',
        baseRevision: 1,
        turnId: identity.turnId,
        runId: identity.runId,
        expansion: {
          filesystem: {
            entries: [
              {
                path: join(owner.capability.canonicalPath, 'another.txt'),
                access: 'read',
                scope: 'exact',
              },
            ],
          },
        },
        justification: 'Read another selected file.',
        createdAt: 2,
      };
      const closures: string[] = [];
      await ownerRun.acceptSandboxBoundaryRequest({
        request: sandboxBoundaryEvent(closingRequest),
        continuation: sandboxBoundaryContinuation(identity, closingRequest.requestId, {
          closure: (reason) => closures.push(reason),
        }),
      });
      await ownerRun.close('turn_stopped');
      assert.deepEqual(closures, ['turn_stopped']);
      const closed = await coordinator.handlers['interaction.query'](
        { sessionId: session.id, interactionId: closingRequest.requestId },
        connection(),
      );
      assert.equal(closed.ok, true);
      if (!closed.ok) return;
      assert.equal(closed.result.status, 'closed');
      assert.equal(closed.result.outcome.kind, 'closure');
      if (closed.result.outcome.kind === 'closure') {
        assert.equal(closed.result.outcome.reason, 'turn_stopped');
      }
      assert.equal(graphWakes, 1);
      ownerRun.release();
      await coordinator.close();
    });
  });

  test('a queued stop waits for sandbox boundary publication before closing its Run', async () => {
    await withStore(async ({ owner, store, stores }) => {
      const workspace = join(owner.capability.canonicalPath, 'publication-workspace');
      await mkdir(workspace);
      const session = await stores.sessionStore.create({
        cwd: workspace,
        backend: 'fake',
        llmConnectionSlug: 'fake',
        model: 'fake-model',
        permissionMode: 'ask',
      });
      const identity = { ...RUN, sessionId: session.id };
      const admissionRefreshStarted = deferred();
      const releaseAdmissionRefresh = deferred();
      let holdAdmissionRefresh = true;
      const gate = new SessionAdmissionGate();
      const coordinator = new HostInteractionCoordinator({
        store,
        sandboxBoundaries: stores.sessionStore,
        sessionAdmission: gate,
        sessions: stores.sessionStore,
        preflightSessionSnapshot: () => true,
        refreshCanonicalContinuity: async () => {
          if (!holdAdmissionRefresh) return;
          holdAdmissionRefresh = false;
          admissionRefreshStarted.resolve();
          await releaseAdmissionRefresh.promise;
        },
        onPoison: () => {},
        onSandboxBoundarySettled: async () => {},
      });
      const binding = await bindRuntimeInteractionRun(coordinator, identity);
      const request = sandboxBoundaryEvent({
        sessionId: session.id,
        requestId: 'boundary_stop_race',
        status: 'pending',
        baseRevision: 0,
        turnId: identity.turnId,
        runId: identity.runId,
        expansion: { network: { enabled: true } },
        justification: 'Connect to the requested service.',
        createdAt: 1,
      });
      let closureReason: string | undefined;
      const admission = binding.admitSandboxBoundaryRequest({
        request,
        settlement: {
          applyDecision: async () => assert.fail('Stop must not approve the boundary'),
          applyClosure: async (reason) => {
            closureReason = reason;
          },
        },
      });
      await admissionRefreshStarted.promise;
      const stop = gate.run(session.id, (lease) =>
        coordinator.claimRunClosure(identity, 'turn_stopped', lease),
      );
      releaseAdmissionRefresh.resolve();

      await admission;
      assert.equal(closureReason, undefined);
      binding.assertPendingAdmission(request);
      await stop;
      assert.equal(closureReason, 'turn_stopped');

      await binding.close('turn_stopped');
      await binding.settleLocalClosures();
      binding.release();
      await coordinator.close();
    });
  });

  test('rejects a hosted sandbox boundary before publication when its snapshot does not fit', async () => {
    await withStore(async ({ owner, store, stores }) => {
      const workspace = join(owner.capability.canonicalPath, 'workspace');
      await mkdir(workspace);
      const session = await stores.sessionStore.create({
        cwd: workspace,
        backend: 'fake',
        llmConnectionSlug: 'fake',
        model: 'fake-model',
        permissionMode: 'ask',
      });
      const identity = { ...RUN, sessionId: session.id };
      const request: SandboxBoundaryRequest = {
        sessionId: session.id,
        requestId: 'boundary_too_large',
        status: 'pending',
        baseRevision: 0,
        turnId: identity.turnId,
        runId: identity.runId,
        expansion: {
          filesystem: {
            entries: [
              {
                path: join(owner.capability.canonicalPath, 'outside.txt'),
                access: 'read',
                scope: 'exact',
              },
            ],
          },
        },
        justification: 'Read the selected file.',
        createdAt: 1,
      };
      const coordinator = new HostInteractionCoordinator({
        store,
        sandboxBoundaries: stores.sessionStore,
        sessionAdmission: new SessionAdmissionGate(),
        sessions: stores.sessionStore,
        preflightSessionSnapshot: () => false,
        refreshCanonicalContinuity: async () => {},
        onPoison: () => {},
        onSandboxBoundarySettled: async () => {},
      });
      const ownerRun = coordinator.bindRun(identity);

      await assert.rejects(
        ownerRun.acceptSandboxBoundaryRequest({
          request: sandboxBoundaryEvent(request),
          continuation: sandboxBoundaryContinuation(identity, request.requestId),
        }),
        (error: unknown) =>
          error instanceof RuntimeInteractionAdmissionRejectedError &&
          error.reason === 'capacity_exceeded',
      );
      assert.equal(
        await stores.sessionStore.readSandboxBoundaryRequest(session.id, request.requestId),
        undefined,
      );
      assert.equal(coordinator.isPoisoned(), false);

      await ownerRun.close('turn_terminal');
      ownerRun.release();
      await coordinator.close();
    });
  });

  test('does not expose settled interactions after Session removal', async () => {
    await withStore(async ({ store }) => {
      let sessionState: 'present' | 'removed' = 'present';
      const coordinator = createCoordinator(store, {
        sessions: {
          probeSessionRemoval: async () => ({ kind: sessionState }),
        },
      });
      const owner = coordinator.bindRun(RUN);
      await owner.acceptUserQuestionRequest({
        request: questionEvent('question_removed_session', 10),
        continuation: questionContinuation('question_removed_session'),
      });
      const answer = {
        sessionId: RUN.sessionId,
        interactionId: 'question_removed_session',
        answer: { kind: 'question', answers: ['Yes'] },
      } as const;
      assert.equal(
        (await coordinator.handlers['interaction.answer'](answer, connection())).ok,
        true,
      );

      sessionState = 'removed';
      assert.deepEqual(
        await coordinator.handlers['interaction.query'](
          { sessionId: RUN.sessionId, interactionId: answer.interactionId },
          connection(),
        ),
        {
          ok: false,
          error: { code: 'not_found', message: 'Interaction was not found' },
        },
      );
      assert.deepEqual(await coordinator.handlers['interaction.answer'](answer, connection()), {
        ok: false,
        error: { code: 'not_found', message: 'Interaction was not found' },
      });

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
            sessionId: RUN.sessionId,
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

    await withStore(async ({ owner, store, stores }) => {
      const orphan = storedQuestion('question_orphan', RUN, 15);
      assert.equal((await store.establishRequest(orphan)).status, 'stable');
      const workspace = join(owner.capability.canonicalPath, 'recovery-workspace');
      await mkdir(workspace);
      const session = await stores.sessionStore.create({
        cwd: workspace,
        backend: 'fake',
        llmConnectionSlug: 'fake',
        model: 'fake-model',
        permissionMode: 'ask',
      });
      const boundary = await stores.sessionStore.createSandboxBoundaryRequest({
        sessionId: session.id,
        requestId: 'boundary_orphan',
        turnId: 'turn_orphan',
        runId: 'run_orphan',
        expansion: { network: { enabled: true } },
        justification: 'Connect to the requested service.',
      });
      const order: string[] = [];
      const coordinator = createCoordinator(store, {
        sandboxBoundaries: stores.sessionStore,
        sessions: stores.sessionStore,
        refreshCanonicalContinuity: async (sessionId) => {
          if (sessionId === RUN.sessionId) {
            const record = await store.readInteraction(orphan.requestId);
            const outcome = record?.outcome?.outcome;
            order.push(
              outcome?.kind === 'closure' ? `refresh:${outcome.reason}` : 'refresh:pending',
            );
            return;
          }
          const recovered = await stores.sessionStore.readSandboxBoundaryRequest(
            session.id,
            boundary.requestId,
          );
          order.push(
            recovered?.status === 'denied'
              ? `refresh:${recovered.outcomeReason}`
              : 'refresh:pending',
          );
        },
      });

      await coordinator.recoverPendingAfterHostRestart();
      assert.deepEqual(order, ['refresh:host_restarted', 'refresh:host_restarted']);
      assert.deepEqual(await store.listPending(), []);
      assert.equal(
        (await stores.sessionStore.readSandboxBoundaryRequest(session.id, boundary.requestId))
          ?.status,
        'denied',
      );
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
    sandboxBoundaries: {
      createSandboxBoundaryRequest: async () => {
        throw new Error('Unexpected sandbox boundary publication');
      },
      readSandboxBoundaryRequest: async () => undefined,
      listPendingSandboxBoundaryRequests: async () => [],
      settleSandboxBoundaryRequest: async () => {
        throw new Error('Unexpected sandbox boundary settlement');
      },
      listHeaders: async () => [],
    },
    sessionAdmission: new SessionAdmissionGate(),
    sessions: {
      probeSessionRemoval: async () => ({ kind: 'present' }),
    },
    now: () => ++now,
    preflightSessionSnapshot: () => true,
    refreshCanonicalContinuity: async () => {},
    onPoison: () => {},
    onSandboxBoundarySettled: async () => {},
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
    waitForPublication: async () => {},
    applyAnswer: async (answer) => {
      await callbacks.answer?.(answer.answers);
    },
    applyClosure: async (reason) => {
      await callbacks.closure?.(reason);
    },
  };
}

function sandboxBoundaryEvent(request: SandboxBoundaryRequest): SandboxBoundaryRequestEvent {
  assert.ok(request.turnId);
  return {
    id: `event_${request.requestId}`,
    type: 'sandbox_boundary_request',
    turnId: request.turnId,
    ts: request.createdAt,
    requestId: request.requestId,
    toolUseId: `tool_${request.requestId}`,
    expansion: request.expansion,
    justification: request.justification,
  };
}

function sandboxBoundaryContinuation(
  identity: RuntimeInteractionRunIdentity,
  requestId: string,
  callbacks: {
    decision?: (status: string) => unknown;
    closure?: (
      reason: Parameters<RuntimeSandboxBoundaryContinuation['applyClosure']>[0],
    ) => unknown;
  } = {},
): RuntimeSandboxBoundaryContinuation {
  return {
    ...identity,
    requestId,
    waitForPublication: async () => {},
    applyDecision: async (settlement) => {
      await callbacks.decision?.(settlement.request.status);
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
  readonly stores: ExecutionStoresWriter<'interactive'>;
}

async function withStore(run: (context: StoreContext) => Promise<void>): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'maka-interaction-coordinator-'));
  const root = join(base, 'root');
  await mkdir(root);
  const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  if (!owner) return;
  const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
  const store = stores.interactionStore;
  try {
    await run({ owner, store, stores });
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

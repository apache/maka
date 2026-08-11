import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AgentRunHeader } from '@maka/core/agent-run';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import {
  openInteractiveExecutionStoresForWrite,
  type ExecutionStoresWriter,
} from '@maka/storage/execution-stores';
import type { StoredInteractionRequest } from '@maka/storage/interaction-store';
import { acquireOperationalStateDatabase } from '@maka/storage';
import {
  createSessionEventMapMemory,
  mapSessionEventToRuntimeEvent,
} from '@maka/runtime/ai-sdk-flow';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import {
  TURN_MESSAGE_TEXT_MAX_BYTES,
  type SessionMessageQueueProjection,
} from '../protocol/index.js';
import {
  type CanonicalSessionProjection,
  CanonicalSessionProjectionReader,
  createSessionContinuitySnapshot,
} from '../server/canonical-session-projection.js';
import { type HostMessageRootPort, HostMessageCoordinator } from '../server/message-coordinator.js';
import { worstCaseGoalProjection } from '../server/goal-projection.js';
import { RootAdmissionOwner } from '../server/root-admission-owner.js';
import { SessionAdmissionGate } from '../server/session-admission-gate.js';
import { worstCaseFailedTurnSnapshot } from '../server/canonical-turn-snapshot.js';

test('projects the canonical root lifecycle and the attachment queue from real Stores', async () => {
  await withStores(async (root, stores) => {
    const session = await stores.sessionStore.create(sessionInput(root));
    const rootAdmissions = new RootAdmissionOwner(stores.agentRunStore);
    await rootAdmissions.recoverSession(session.id);
    const messages = createMessages(session.id, stores);
    const reader = new CanonicalSessionProjectionReader({
      stores,
      rootAdmissions,
      messages,
    });

    assert.deepEqual(await reader.read(session.id), {
      session: {
        sessionId: session.id,
        metadataRevision: 1,
        status: session.status,
        createdAt: session.createdAt,
        lastUsedAt: session.lastUsedAt,
        isArchived: false,
      },
      rootTurn: null,
      goal: null,
      queue: { hostEpoch: 'epoch-1', queueRevision: 0, steering: [], followup: [] },
      interactions: { pending: [] },
    });

    const admitted = await rootAdmissions.admitRootTurn({
      sessionId: session.id,
      turnId: 'turn-1',
      proposedRunId: 'run-1',
      proposedUserMessageId: 'user-1',
      execution: { kind: 'external_message' },
      normalizedInput: { text: 'hello' },
      sourceMessages: [],
      admittedAt: 10,
    });
    const admittedProjection = await reader.read(session.id);
    assert.ok(admittedProjection);
    assert.equal(admittedProjection.rootTurn?.status, 'admitted');

    await stores.agentRunStore.createRun(runHeader(session.id));
    await stores.agentRunStore.appendEvent(session.id, 'run-1', {
      type: 'run_started',
      id: 'run-started-1',
      sessionId: session.id,
      turnId: 'turn-1',
      runId: 'run-1',
      ts: 11,
    });
    await stores.agentRunStore.updateRun(session.id, 'run-1', {
      status: 'running',
      updatedAt: 11,
    });

    messages.reserveRootTurn({ sessionId: session.id, turnId: 'turn-1', runId: 'run-1' });
    const attachment = {
      kind: 'image' as const,
      name: 'evidence.png',
      mimeType: 'image/png',
      bytes: 12,
      ref: { kind: 'workspace_file' as const, relativePath: 'evidence.png' },
    };
    const submitted = await messages.handlers['turn.message.submit'](
      {
        originHostEpoch: 'epoch-1',
        sessionId: session.id,
        messageId: 'queued-1',
        content: { text: 'inspect this', attachments: [attachment] },
        placement: 'current_turn',
      },
      operationContext(),
    );
    assert.equal(submitted.ok, true);
    const running = await reader.read(session.id);
    assert.ok(running);
    assert.equal(running.rootTurn?.status, 'running');
    assert.deepEqual(running.queue.steering[0]?.content.attachments, [attachment]);

    const terminal = terminalEvent(session.id);
    await stores.runtimeEventStore.appendRuntimeEvent(session.id, 'run-1', terminal);
    await stores.agentRunStore.updateRun(session.id, 'run-1', {
      status: 'completed',
      updatedAt: 12,
      completedAt: 12,
    });
    const completed = await reader.read(session.id);
    assert.ok(completed);
    assert.deepEqual(completed.rootTurn, {
      sessionId: session.id,
      turnId: admitted.admission.turnId,
      runId: admitted.admission.runId,
      status: 'completed',
      terminalEventId: terminal.id,
    });

    await messages.handlers['queue.retract'](
      { originHostEpoch: 'epoch-1', sessionId: session.id, retractId: 'cleanup' },
      operationContext(),
    );
    messages.abandonRootReservation({ sessionId: session.id, turnId: 'turn-1', runId: 'run-1' });
    await messages.close();
  });
});

test('projects pending Interactions and preflights their combined snapshot capacity', async () => {
  await withStores(async (root, stores) => {
    const session = await stores.sessionStore.create(sessionInput(root));
    const messages = createMessages(session.id, stores);
    const reader = new CanonicalSessionProjectionReader({
      stores,
      rootAdmissions: new RootAdmissionOwner(stores.agentRunStore),
      messages,
    });
    for (let index = 0; index < 5; index += 1) {
      const established = await stores.interactionStore.establishRequest(
        largePendingInteraction(session.id, index),
      );
      assert.equal(established.status, 'stable');
    }

    const canonical = await reader.read(session.id);
    assert.ok(canonical);
    assert.equal(canonical.interactions.pending.length, 5);
    assert.deepEqual(
      canonical.interactions.pending.map((interaction) => interaction.interactionId),
      Array.from({ length: 5 }, (_, index) => `interaction-${index}`),
    );

    const emptyQueue = messages.projection(session.id);
    const largeQueue = {
      ...emptyQueue,
      queueRevision: 1,
      followup: [
        {
          entryId: 'large-entry',
          messageId: 'large-message',
          content: { text: 'q'.repeat(8 * 1024) },
          placement: 'next_turn' as const,
          state: 'queued' as const,
        },
      ],
    };
    assert.equal(
      await reader.fitsCandidate(session.id, {
        queue: largeQueue,
        interactions: { pending: [] },
      }),
      true,
    );
    assert.equal(
      await reader.fitsCandidate(session.id, {
        queue: emptyQueue,
        interactions: canonical.interactions,
      }),
      true,
    );
    assert.equal(
      await reader.fitsCandidate(session.id, {
        queue: largeQueue,
        interactions: canonical.interactions,
      }),
      false,
    );
  });
});

test('preflights queued steering at the exact in-flight snapshot boundary', async () => {
  await withStores(async (root, stores) => {
    const session = await stores.sessionStore.create(sessionInput(root));
    for (let index = 0; index < 5; index += 1) {
      const established = await stores.interactionStore.establishRequest(
        largePendingInteraction(session.id, index),
      );
      assert.equal(established.status, 'stable');
    }

    let currentQueue: SessionMessageQueueProjection = {
      hostEpoch: 'epoch-1',
      queueRevision: 1,
      steering: [],
      followup: [],
    };
    const reader = new CanonicalSessionProjectionReader({
      stores,
      rootAdmissions: new RootAdmissionOwner(stores.agentRunStore),
      messages: { projection: () => currentQueue },
    });
    const canonical = await reader.read(session.id);
    assert.ok(canonical);
    const capacityCanonical = {
      ...canonical,
      goal: worstCaseGoalProjection(session.id),
    };

    const inFlightBoundary = largestFittingInFlightSteeringText(capacityCanonical);
    const rejectedQueued = {
      ...steeringQueue(inFlightBoundary + 1, 'queued'),
      queueRevision: 1,
    };
    assert.deepEqual(
      createSessionContinuitySnapshot(
        { ...capacityCanonical, queue: rejectedQueued },
        Number.MAX_SAFE_INTEGER,
      ).queue,
      rejectedQueued,
    );
    assert.throws(() =>
      createSessionContinuitySnapshot(
        {
          ...capacityCanonical,
          queue: steeringQueue(inFlightBoundary + 1, 'in_flight'),
        },
        Number.MAX_SAFE_INTEGER,
      ),
    );

    currentQueue = rejectedQueued;
    assert.equal(
      await reader.fitsCandidate(session.id, { interactions: canonical.interactions }),
      false,
    );
    assert.equal(
      await reader.fitsCandidate(session.id, {
        queue: rejectedQueued,
        interactions: canonical.interactions,
      }),
      false,
    );

    const allowedQueued = { ...steeringQueue(inFlightBoundary, 'queued'), queueRevision: 1 };
    const allowedInFlight = steeringQueue(inFlightBoundary, 'in_flight');
    assert.deepEqual(
      createSessionContinuitySnapshot(
        { ...capacityCanonical, queue: allowedInFlight },
        Number.MAX_SAFE_INTEGER,
      ).queue,
      allowedInFlight,
    );

    currentQueue = allowedQueued;
    assert.equal(
      await reader.fitsCandidate(session.id, { interactions: canonical.interactions }),
      true,
    );
    assert.equal(
      await reader.fitsCandidate(session.id, {
        queue: allowedQueued,
        interactions: canonical.interactions,
      }),
      true,
    );
  });
});

test('preflights the worst-case failed Turn before accepting more queued content', async () => {
  await withStores(async (root, stores) => {
    const { sessionId, rootAdmissions } = await createRunningRoot(root, stores);

    let currentQueue: SessionMessageQueueProjection = {
      hostEpoch: 'epoch-1',
      queueRevision: 1,
      steering: [],
      followup: [],
    };
    const reader = new CanonicalSessionProjectionReader({
      stores,
      rootAdmissions,
      messages: { projection: () => currentQueue },
    });
    const canonical = await reader.read(sessionId);
    assert.ok(canonical?.rootTurn);
    const capacityCanonical = {
      ...canonical,
      goal: worstCaseGoalProjection(sessionId),
    };
    currentQueue = largestFittingFollowupQueue(capacityCanonical);

    assert.doesNotThrow(() =>
      createSessionContinuitySnapshot(
        { ...capacityCanonical, queue: currentQueue },
        Number.MAX_SAFE_INTEGER,
      ),
    );
    assert.throws(() =>
      createSessionContinuitySnapshot(
        {
          ...capacityCanonical,
          rootTurn: worstCaseFailedTurnSnapshot(capacityCanonical.rootTurn!),
          queue: currentQueue,
        },
        Number.MAX_SAFE_INTEGER,
      ),
    );
    assert.equal(await reader.fitsCandidate(sessionId, { queue: currentQueue }), false);
  });
});

test('projects a failed Turn message from the canonical terminal event', async () => {
  await withStores(async (root, stores) => {
    const { sessionId, rootAdmissions } = await createRunningRoot(root, stores);
    const memory = createSessionEventMapMemory();
    const context = {
      sessionId,
      invocationId: 'run-1',
      runId: 'run-1',
      turnId: 'turn-1',
      source: 'test',
      startedAt: 10,
      request: {
        sessionId,
        invocationId: 'run-1',
        runId: 'run-1',
        turnId: 'turn-1',
        text: 'hello',
        source: 'test',
      },
      newId: () => 'unused',
      now: () => 12,
    } as const;
    const errorEvent = mapSessionEventToRuntimeEvent(
      {
        type: 'error',
        id: 'provider-error-1',
        turnId: 'turn-1',
        ts: 12,
        recoverable: false,
        code: 'provider_error',
        message: 'canonical provider failure api_key=sk-test-secret-value',
      },
      context,
      memory,
    );
    const terminalEvent = mapSessionEventToRuntimeEvent(
      {
        type: 'complete',
        id: 'terminal-failed-1',
        turnId: 'turn-1',
        ts: 13,
        stopReason: 'error',
      },
      context,
      memory,
    );
    await stores.runtimeEventStore.appendRuntimeEvent(sessionId, 'run-1', errorEvent);
    await stores.runtimeEventStore.appendRuntimeEvent(sessionId, 'run-1', terminalEvent);
    await stores.agentRunStore.updateRun(sessionId, 'run-1', {
      status: 'failed',
      updatedAt: 13,
      completedAt: 13,
      failureClass: 'provider_error',
      failureMessage: 'stale Run header failure',
    });

    const reader = new CanonicalSessionProjectionReader({
      stores,
      rootAdmissions,
      messages: {
        projection: () => ({ hostEpoch: 'epoch-1', queueRevision: 0, steering: [], followup: [] }),
      },
    });
    const canonical = await reader.read(sessionId);
    assert.equal(canonical?.rootTurn?.status, 'failed');
    if (canonical?.rootTurn?.status === 'failed') {
      assert.equal(
        canonical.rootTurn.failureMessage,
        'canonical provider failure api_key=[redacted]',
      );
    }
  });
});

test('propagates canonical Store read failures during candidate preflight', async () => {
  await withStores(async (root, stores) => {
    const session = await stores.sessionStore.create(sessionInput(root));
    const readFailure = new Error('interaction list read failed');
    const failingStores: ExecutionStoresWriter<'interactive'> = {
      ...stores,
      interactionStore: {
        ...stores.interactionStore,
        listSessionPending: async () => {
          throw readFailure;
        },
      },
    };
    const reader = new CanonicalSessionProjectionReader({
      stores: failingStores,
      rootAdmissions: new RootAdmissionOwner(stores.agentRunStore),
      messages: createMessages(session.id, stores),
    });

    await assert.rejects(
      () => reader.fitsCandidate(session.id, {}),
      (error) => {
        assert.equal(error, readFailure);
        return true;
      },
    );
  });
});

test('fails closed when the owned tip durable identity changes', async () => {
  await withStores(async (root, stores) => {
    const session = await stores.sessionStore.create(sessionInput(root));
    const rootAdmissions = new RootAdmissionOwner(stores.agentRunStore);
    await rootAdmissions.recoverSession(session.id);
    await rootAdmissions.admitRootTurn({
      sessionId: session.id,
      turnId: 'turn-1',
      proposedRunId: 'run-1',
      proposedUserMessageId: 'user-1',
      execution: { kind: 'external_message' },
      normalizedInput: { text: 'hello' },
      sourceMessages: [],
      admittedAt: 10,
    });
    const database = acquireOperationalStateDatabase(root);
    const row = database.database
      .prepare(`
        SELECT admitted_at, record_json
        FROM core_root_turn_admissions
        WHERE session_id = ? AND turn_id = 'turn-1'
      `)
      .get(session.id) as { admitted_at?: unknown; record_json?: unknown } | undefined;
    assert.equal(typeof row?.admitted_at, 'number');
    assert.equal(typeof row?.record_json, 'string');
    const durable = JSON.parse(row!.record_json as string) as Record<string, unknown>;

    database.transaction('write', () => {
      database.database
        .prepare(`
          DELETE FROM core_root_turn_admissions
          WHERE session_id = ? AND turn_id = 'turn-1'
        `)
        .run(session.id);
    });
    const missingReader = new CanonicalSessionProjectionReader({
      stores,
      rootAdmissions,
      messages: createMessages(session.id, stores),
    });
    await assert.rejects(() => missingReader.read(session.id), /missing from durable storage/);

    database.transaction('write', () => {
      database.database
        .prepare(`
          INSERT INTO core_root_turn_admissions(
            session_id, turn_id, admitted_at, record_json
          ) VALUES (?, 'turn-1', ?, ?)
        `)
        .run(
          session.id,
          row!.admitted_at as number,
          JSON.stringify({ ...durable, runId: 'run-drifted' }),
        );
    });
    database.close();

    const reader = new CanonicalSessionProjectionReader({
      stores,
      rootAdmissions,
      messages: createMessages(session.id, stores),
    });
    await assert.rejects(() => reader.read(session.id), /identity changed/);
  });
});

function createMessages(
  sessionId: string,
  stores: ExecutionStoresWriter<'interactive'>,
): HostMessageCoordinator {
  const root: HostMessageRootPort = {
    readSessionHeader: async () => ({ isArchived: false }),
    readRootState: () => ({ kind: 'active', sessionId, turnId: 'turn-1', runId: 'run-1' }),
    claimStopFence: async () => ({
      ready: Promise.resolve(),
      deliverStop: () => Promise.resolve(),
    }),
    startFromMessage: async () => {
      throw new Error('unexpected root start');
    },
    prepareMessage: async (input) => ({ kind: 'ready', content: input.content }),
    claimStop: async () => {
      throw new Error('unexpected root stop');
    },
  };
  return new HostMessageCoordinator({
    hostEpoch: 'epoch-1',
    root,
    durableProof: {
      readRootTurnSourceMessageReceipt: (requestedSessionId, messageId) =>
        stores.agentRunStore.readRootTurnSourceMessageReceipt(requestedSessionId, messageId),
      readImmutableSteeringMessageProof: (requestedSessionId, messageId) =>
        stores.runtimeEventStore.readImmutableSteeringMessageProof(requestedSessionId, messageId),
    },
    receipts: stores.messageReceiptStore,
    sessionAdmission: new SessionAdmissionGate(),
    acquireResidency: () => ({ release: () => undefined }),
    preflightSessionSnapshot: () => true,
    createId: () => 'entry-1',
  });
}

function sessionInput(root: string) {
  return {
    cwd: root,
    backend: 'fake' as const,
    llmConnectionSlug: 'fake',
    model: 'fake-model',
    permissionMode: 'ask' as const,
  };
}

function runHeader(sessionId: string): AgentRunHeader {
  return {
    runId: 'run-1',
    invocationId: 'run-1',
    sessionId,
    turnId: 'turn-1',
    status: 'created',
    backendKind: 'fake',
    llmConnectionSlug: 'fake',
    modelId: 'fake-model',
    cwd: '/private/runtime-cwd',
    permissionMode: 'ask',
    createdAt: 10,
    updatedAt: 10,
  };
}

async function createRunningRoot(
  root: string,
  stores: ExecutionStoresWriter<'interactive'>,
): Promise<{ sessionId: string; rootAdmissions: RootAdmissionOwner }> {
  const session = await stores.sessionStore.create(sessionInput(root));
  const rootAdmissions = new RootAdmissionOwner(stores.agentRunStore);
  await rootAdmissions.recoverSession(session.id);
  await rootAdmissions.admitRootTurn({
    sessionId: session.id,
    turnId: 'turn-1',
    proposedRunId: 'run-1',
    proposedUserMessageId: 'user-1',
    execution: { kind: 'external_message' },
    normalizedInput: { text: 'hello' },
    sourceMessages: [],
    admittedAt: 10,
  });
  await stores.agentRunStore.createRun(runHeader(session.id));
  await stores.agentRunStore.appendEvent(session.id, 'run-1', {
    type: 'run_started',
    id: 'run-started-1',
    sessionId: session.id,
    turnId: 'turn-1',
    runId: 'run-1',
    ts: 11,
  });
  await stores.agentRunStore.updateRun(session.id, 'run-1', {
    status: 'running',
    updatedAt: 11,
  });
  return { sessionId: session.id, rootAdmissions };
}

function terminalEvent(sessionId: string): RuntimeEvent {
  return {
    id: 'terminal-1',
    invocationId: 'run-1',
    sessionId,
    turnId: 'turn-1',
    runId: 'run-1',
    ts: 12,
    partial: false,
    status: 'completed',
    role: 'model',
    author: 'agent',
    content: { kind: 'text', text: 'done' },
  };
}

function operationContext() {
  return {
    hostEpoch: 'epoch-1',
    connectionId: 'connection-1',
    surface: 'tui' as const,
    principal: 'local_os_user' as const,
    acquireResidency: () => ({ release: () => undefined }),
  };
}

async function withStores(
  run: (root: string, stores: ExecutionStoresWriter<'interactive'>) => Promise<void>,
): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'maka-canonical-session-'));
  const capability = await resolveStorageRoot({
    path: join(base, 'root'),
    kind: 'interactive',
  });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  if (!owner) throw new Error('Unable to acquire test root');
  try {
    const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
    await stores.messageReceiptStore.beginHostEpoch('epoch-1');
    await run(capability.canonicalPath, stores);
  } finally {
    await owner.close();
    await rm(base, { recursive: true, force: true });
  }
}

function largePendingInteraction(sessionId: string, index: number): StoredInteractionRequest {
  return {
    sessionId,
    turnId: 'turn-1',
    runId: 'run-1',
    requestId: `interaction-${index}`,
    createdAt: index,
    request: {
      kind: 'question',
      toolUseId: `tool-${index}`,
      questions: Array.from({ length: 3 }, (_, questionIndex) => ({
        question: `${questionIndex}${'x'.repeat(1023)}`,
        options: Array.from({ length: 3 }, (_, optionIndex) => ({
          label: `${optionIndex}${'l'.repeat(255)}`,
          description: 'z'.repeat(512),
        })),
      })),
    },
  };
}

function steeringQueue(
  textBytes: number,
  state: 'queued' | 'in_flight',
): SessionMessageQueueProjection {
  return {
    hostEpoch: 'epoch-1',
    queueRevision: Number.MAX_SAFE_INTEGER,
    steering: [
      {
        entryId: 'boundary-entry',
        messageId: 'boundary-message',
        content: { text: 'q'.repeat(textBytes) },
        placement: 'current_turn',
        state,
      },
    ],
    followup: [],
  };
}

function largestFittingInFlightSteeringText(canonical: CanonicalSessionProjection): number {
  let lower = 0;
  let upper = 1;
  const fits = (textBytes: number): boolean => {
    try {
      createSessionContinuitySnapshot(
        { ...canonical, queue: steeringQueue(textBytes, 'in_flight') },
        Number.MAX_SAFE_INTEGER,
      );
      return true;
    } catch {
      return false;
    }
  };
  while (fits(upper)) upper *= 2;
  while (lower + 1 < upper) {
    const midpoint = Math.floor((lower + upper) / 2);
    if (fits(midpoint)) lower = midpoint;
    else upper = midpoint;
  }
  return lower;
}

function largestFittingFollowupQueue(
  canonical: CanonicalSessionProjection,
): SessionMessageQueueProjection {
  const queue = (tailBytes: number): SessionMessageQueueProjection => ({
    hostEpoch: 'epoch-1',
    queueRevision: Number.MAX_SAFE_INTEGER,
    steering: [],
    followup: [
      {
        entryId: 'large-entry',
        messageId: 'large-message',
        content: { text: 'q'.repeat(TURN_MESSAGE_TEXT_MAX_BYTES) },
        placement: 'next_turn',
        state: 'queued',
      },
      {
        entryId: 'tail-entry',
        messageId: 'tail-message',
        content: { text: 'q'.repeat(tailBytes) },
        placement: 'next_turn',
        state: 'queued',
      },
    ],
  });
  const fits = (tailBytes: number): boolean => {
    try {
      createSessionContinuitySnapshot(
        { ...canonical, queue: queue(tailBytes) },
        Number.MAX_SAFE_INTEGER,
      );
      return true;
    } catch {
      return false;
    }
  };
  let lower = 0;
  let upper = TURN_MESSAGE_TEXT_MAX_BYTES;
  while (lower + 1 < upper) {
    const midpoint = Math.floor((lower + upper) / 2);
    if (fits(midpoint)) lower = midpoint;
    else upper = midpoint;
  }
  return queue(lower);
}

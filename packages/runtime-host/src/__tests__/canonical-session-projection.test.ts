import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AgentRunHeader, RuntimeEvent } from '@maka/core';
import {
  openInteractiveExecutionStoresForWrite,
  type ExecutionStoresWriter,
} from '@maka/storage/execution-stores';
import type { StoredInteractionRequest } from '@maka/storage/interaction-store';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import { CanonicalSessionProjectionReader } from '../server/canonical-session-projection.js';
import { type HostMessageRootPort, HostMessageCoordinator } from '../server/message-coordinator.js';
import { RootAdmissionOwner } from '../server/root-admission-owner.js';
import { SessionAdmissionGate } from '../server/session-admission-gate.js';

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
        status: session.status,
        createdAt: session.createdAt,
        lastUsedAt: session.lastUsedAt,
        isArchived: false,
      },
      rootTurn: null,
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

test('propagates canonical Store read failures during candidate preflight', async () => {
  await withStores(async (root, stores) => {
    const session = await stores.sessionStore.create(sessionInput(root));
    const readFailure = new Error('interaction list read failed');
    const failingStores: ExecutionStoresWriter<'interactive'> = {
      ...stores,
      interactionStore: {
        ...stores.interactionStore,
        listPending: async () => {
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
    const admissionPath = join(root, 'sessions', session.id, 'turn-admissions', 'turn-1.json');
    const original = await readFile(admissionPath, 'utf8');
    const durable = JSON.parse(original) as Record<string, unknown>;

    await rm(admissionPath);
    const missingReader = new CanonicalSessionProjectionReader({
      stores,
      rootAdmissions,
      messages: createMessages(session.id, stores),
    });
    await assert.rejects(() => missingReader.read(session.id), /missing from durable storage/);

    await writeFile(admissionPath, `${JSON.stringify({ ...durable, runId: 'run-drifted' })}\n`);

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
    startFromMessage: async () => {
      throw new Error('unexpected root start');
    },
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

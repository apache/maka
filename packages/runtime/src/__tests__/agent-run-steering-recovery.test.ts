import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentRunHeader, RuntimeEvent } from '@maka/core';
import type { SessionEvent } from '@maka/core/events';
import {
  createAgentRunStore,
  createLegacyFileSessionStore,
  createRuntimeEventStore,
} from '@maka/storage';
import { AgentRun } from '../agent-run.js';

test('acks a steering event whose canonical append preceded proof publication failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-agent-run-steering-recovery-'));
  try {
    const store = createLegacyFileSessionStore(root);
    const session = await store.create({
      cwd: '/tmp/cwd',
      backend: 'fake',
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'ask',
    });
    const runStore = createAgentRunStore(root);
    const runtimeEventStore = createRuntimeEventStore(root);
    const runId = 'run-1';
    const turnId = 'turn-1';
    await runStore.createRun(makeRunHeader(session.id, runId, turnId));
    const run = new AgentRun({
      sessionId: session.id,
      header: session,
      userInput: { turnId, text: 'start' },
      runId,
      store,
      runStore,
      runtimeEventStore,
      newId: () => 'unused-id',
      now: () => 10,
      recordSessionMessages: false,
      hooks: {
        ensureActive: async () => {
          throw new Error('ensureActive should not be called');
        },
        registerRun: () => {},
        unregisterRun: () => {},
        updateHeader: (sessionId, patch) => store.updateHeader(sessionId, patch),
        updateStatus: async () => {},
        appendTurnState: async () => {},
      },
    });
    const sessionEvent: SessionEvent = {
      type: 'steering_message',
      id: 'runtime-steering',
      turnId,
      ts: 2,
      messageId: 'message-steering',
      content: { text: 'persist me once' },
    };
    const runtimeEvent: RuntimeEvent = {
      id: sessionEvent.id,
      invocationId: run.invocationId,
      runId,
      sessionId: session.id,
      turnId,
      ts: sessionEvent.ts,
      partial: false,
      role: 'user',
      author: 'user',
      content: { kind: 'text', text: 'persist me once', steering: true },
      refs: { providerEventId: sessionEvent.messageId },
    };
    const proofDirectory = join(root, 'sessions', session.id, 'message-proofs', 'steering');
    await mkdir(proofDirectory, { recursive: true });
    await chmod(proofDirectory, 0o500);

    await run.acceptMappedEvent(sessionEvent, runtimeEvent);

    await chmod(proofDirectory, 0o700);
    await rm(proofDirectory, { recursive: true });
    const recovered = createRuntimeEventStore(root);
    await recovered.repairImmutableSteeringMessageProofsForRecovery(session.id);
    assert.deepEqual(await recovered.readImmutableRuntimeEvents(session.id, runId), [runtimeEvent]);
    assert.deepEqual(
      await recovered.readImmutableSteeringMessageProof(session.id, sessionEvent.messageId),
      { event: runtimeEvent },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function makeRunHeader(sessionId: string, runId: string, turnId: string): AgentRunHeader {
  return {
    runId,
    sessionId,
    turnId,
    status: 'running',
    backendKind: 'fake',
    llmConnectionSlug: 'fake',
    modelId: 'fake-model',
    cwd: '/tmp/cwd',
    permissionMode: 'ask',
    createdAt: 1,
    updatedAt: 1,
  };
}

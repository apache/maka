import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { AgentRunHeader, RuntimeEvent } from '@maka/core';
import { openInteractiveExecutionStoresForWrite } from '@maka/storage/execution-stores';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import { createSessionTranscriptReader } from '../server/session-transcript-reader.js';

test('projects canonical active text and thinking snapshots over Session history', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-session-transcript-'));
  const capability = await resolveStorageRoot({
    path: join(base, 'root'),
    kind: 'interactive',
  });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  if (!owner) assert.fail('expected the interactive root owner');
  try {
    const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
    const session = await stores.sessionStore.create({
      cwd: capability.canonicalPath,
      backend: 'fake',
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'ask',
    });
    await stores.sessionStore.appendMessage(session.id, {
      type: 'system_note',
      id: 'history-1',
      ts: 1,
      kind: 'session_start',
    });
    await stores.agentRunStore.createRun(runHeader(session.id));
    await stores.runtimeEventStore.appendRuntimeEvent(
      session.id,
      'run-1',
      runtimeEvent(session.id, {
        id: 'user-event-1',
        ts: 2,
        role: 'user',
        author: 'user',
        content: { kind: 'text', text: 'hello' },
        refs: { storedMessageId: 'user-1' },
      }),
    );
    await stores.runtimeEventStore.appendRuntimeEvent(
      session.id,
      'run-1',
      runtimeEvent(session.id, {
        id: 'thinking-partial-1',
        ts: 3,
        partial: true,
        role: 'model',
        author: 'agent',
        content: { kind: 'thinking', text: 'deep ' },
        refs: { providerEventId: 'assistant-1' },
      }),
    );
    await stores.runtimeEventStore.appendRuntimeEvent(
      session.id,
      'run-1',
      runtimeEvent(session.id, {
        id: 'thinking-partial-2',
        ts: 4,
        partial: true,
        role: 'model',
        author: 'agent',
        content: { kind: 'thinking', text: 'thought' },
        refs: { providerEventId: 'assistant-1' },
      }),
    );
    await stores.runtimeEventStore.appendRuntimeEvent(
      session.id,
      'run-1',
      runtimeEvent(session.id, {
        id: 'text-partial-1',
        ts: 5,
        partial: true,
        role: 'model',
        author: 'agent',
        content: { kind: 'text', text: 'still ' },
        refs: { providerEventId: 'assistant-1' },
      }),
    );
    await stores.runtimeEventStore.appendRuntimeEvent(
      session.id,
      'run-1',
      runtimeEvent(session.id, {
        id: 'text-partial-2',
        ts: 6,
        partial: true,
        role: 'model',
        author: 'agent',
        content: { kind: 'text', text: 'streaming' },
        refs: { providerEventId: 'assistant-1' },
      }),
    );
    await stores.runtimeEventStore.appendRuntimeEvent(
      session.id,
      'run-1',
      runtimeEvent(session.id, {
        id: 'thinking-only-1',
        ts: 7,
        partial: true,
        role: 'model',
        author: 'agent',
        content: { kind: 'thinking', text: 'still ' },
        refs: { providerEventId: 'assistant-2' },
      }),
    );
    await stores.runtimeEventStore.appendRuntimeEvent(
      session.id,
      'run-1',
      runtimeEvent(session.id, {
        id: 'superseded-text-partial',
        ts: 9,
        partial: true,
        role: 'model',
        author: 'agent',
        content: { kind: 'text', text: 'not final' },
        refs: { providerEventId: 'assistant-3' },
      }),
    );
    await stores.runtimeEventStore.appendRuntimeEvent(
      session.id,
      'run-1',
      runtimeEvent(session.id, {
        id: 'complete-text',
        ts: 10,
        role: 'model',
        author: 'agent',
        content: { kind: 'text', text: 'final text' },
        refs: { providerEventId: 'assistant-3' },
      }),
    );
    await stores.runtimeEventStore.appendRuntimeEvent(
      session.id,
      'run-1',
      runtimeEvent(session.id, {
        id: 'thinking-only-2',
        ts: 8,
        partial: true,
        role: 'model',
        author: 'agent',
        content: { kind: 'thinking', text: 'reasoning' },
        refs: { providerEventId: 'assistant-2' },
      }),
    );

    const read = createSessionTranscriptReader({
      stores,
      canonicalPermissionOutcomes: { readPermissionOutcome: async () => undefined },
    });
    const messages = await read(session.id, {
      sessionId: session.id,
      turnId: 'turn-1',
      runId: 'run-1',
      status: 'running',
    });

    assert.deepEqual(
      messages.map((message) => ({ type: message.type, id: message.id })),
      [
        { type: 'system_note', id: 'history-1' },
        { type: 'user', id: 'user-1' },
        { type: 'assistant', id: 'assistant-1' },
        { type: 'assistant', id: 'assistant-2' },
        { type: 'assistant', id: 'assistant-3' },
      ],
    );
    const firstAssistant = messages.at(-3);
    assert.equal(firstAssistant?.type, 'assistant');
    if (firstAssistant?.type === 'assistant') {
      assert.equal(firstAssistant.text, 'still streaming');
      assert.equal(firstAssistant.thinking?.text, 'deep thought');
    }
    const thinkingOnly = messages.at(-2);
    assert.equal(thinkingOnly?.type, 'assistant');
    if (thinkingOnly?.type === 'assistant') {
      assert.equal(thinkingOnly.text, '');
      assert.equal(thinkingOnly.thinking?.text, 'still reasoning');
    }
    const completed = messages.at(-1);
    assert.equal(completed?.type, 'assistant');
    if (completed?.type === 'assistant') assert.equal(completed.text, 'final text');
  } finally {
    await owner.close();
    await rm(base, { recursive: true, force: true });
  }
});

function runHeader(sessionId: string): AgentRunHeader {
  return {
    runId: 'run-1',
    invocationId: 'run-1',
    sessionId,
    turnId: 'turn-1',
    status: 'running',
    backendKind: 'fake',
    llmConnectionSlug: 'fake',
    modelId: 'fake-model',
    cwd: '/tmp',
    permissionMode: 'ask',
    createdAt: 1,
    updatedAt: 1,
  };
}

function runtimeEvent(sessionId: string, overrides: Partial<RuntimeEvent>): RuntimeEvent {
  return {
    id: 'event-1',
    invocationId: 'run-1',
    sessionId,
    turnId: 'turn-1',
    runId: 'run-1',
    ts: 1,
    partial: false,
    role: 'system',
    author: 'system',
    ...overrides,
  };
}

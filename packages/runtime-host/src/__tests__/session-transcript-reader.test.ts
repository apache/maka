/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { AgentRunHeader } from '@maka/core/agent-run';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import {
  type ExecutionStoresWriter,
  openInteractiveExecutionStoresForWrite,
} from '@maka/storage/execution-stores';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import { createSessionTranscriptReader } from '../server/session-transcript-reader.js';

test('keeps durable history separate from the canonical active overlay', async () => {
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
    const messages = await read.readActiveOverlay(session.id, {
      sessionId: session.id,
      turnId: 'turn-1',
      runId: 'run-1',
      status: 'running',
    });

    assert.deepEqual(
      messages.map((message) => ({ type: message.type, id: message.id })),
      [
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

    const durable = await read.readDurablePage(session.id, {
      direction: 'older',
      maxBytes: 1024,
      maxMessages: 10,
    });
    assert.equal(durable.throughSequence, 0);
    assert.deepEqual(
      durable.fragments.map((fragment) => JSON.parse(fragment.data.toString('utf8'))),
      [{ type: 'system_note', id: 'history-1', ts: 1, kind: 'session_start' }],
    );
  } finally {
    await owner.close();
    await rm(base, { recursive: true, force: true });
  }
});

test('stops scanning a control-only ledger at the cumulative immutable event limit', async () => {
  const sessionId = 'session-1';
  const events = Array.from({ length: 8_193 }, (_, index) =>
    runtimeEvent(sessionId, {
      id: `artifact-${index}`,
      ts: index + 1,
      role: 'system',
      author: 'system',
      actions: { artifactDelta: { bytes: index } },
    }),
  );
  let scanned = 0;
  const stores = {
    agentRunStore: { readRun: async () => runHeader(sessionId) },
    runtimeEventStore: {
      readRuntimeEventsBounded: async () => ({ status: 'limit_exceeded' as const }),
      scanRuntimeEvents: async (
        _sessionId: string,
        _runId: string,
        budget: { readonly maxImmutableRecords: number },
        visit: (batch: readonly RuntimeEvent[]) => void,
      ) => {
        for (let offset = 0; offset < events.length; offset += 128) {
          const batch = events.slice(offset, offset + 128);
          if (offset + batch.length > budget.maxImmutableRecords) {
            return { status: 'limit_exceeded' as const };
          }
          scanned += batch.length;
          visit(batch);
        }
        return { status: 'complete' as const };
      },
    },
  } as unknown as ExecutionStoresWriter<'interactive'>;
  const read = createSessionTranscriptReader({
    stores,
    canonicalPermissionOutcomes: { readPermissionOutcome: async () => undefined },
  });

  await assert.rejects(
    read.readActiveOverlay(sessionId, {
      sessionId,
      turnId: 'turn-1',
      runId: 'run-1',
      status: 'running',
    }),
    /storage scan limit/,
  );
  assert.equal(scanned, 8_192);
});

test('stops an oversized active projection before retaining the full RuntimeEvent ledger', async () => {
  const sessionId = 'session-1';
  const events = Array.from({ length: 8_193 }, (_, index) =>
    runtimeEvent(sessionId, {
      id: `user-${index}`,
      ts: index + 1,
      role: 'user',
      author: 'user',
      content: { kind: 'text', text: 'x' },
      refs: { storedMessageId: `message-${index}` },
    }),
  );
  let visited = 0;
  const stores = {
    agentRunStore: { readRun: async () => runHeader(sessionId) },
    runtimeEventStore: {
      scanRuntimeEvents: async (
        _sessionId: string,
        _runId: string,
        _budget: unknown,
        visit: (batch: readonly RuntimeEvent[]) => void,
      ) => {
        for (let offset = 0; offset < events.length; offset += 128) {
          visited += Math.min(128, events.length - offset);
          visit(events.slice(offset, offset + 128));
        }
        return { status: 'complete' as const };
      },
    },
  } as unknown as ExecutionStoresWriter<'interactive'>;
  const read = createSessionTranscriptReader({
    stores,
    canonicalPermissionOutcomes: { readPermissionOutcome: async () => undefined },
  });

  await assert.rejects(
    read.readActiveOverlay(sessionId, {
      sessionId,
      turnId: 'turn-1',
      runId: 'run-1',
      status: 'running',
    }),
    /exceeds its event limit/,
  );
  assert.equal(visited, 8_193);
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

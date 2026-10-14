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
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WORKHUB_COORDINATION_SESSION_ID, type StoredMessage } from '@maka/core/session';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import { seedInvocation } from '@maka/runtime/test-only/invocation-fixture';
import type { MakaToolContext } from '@maka/runtime/tool-runtime';
import { openInteractiveExecutionStoresForWrite } from '@maka/storage/execution-stores';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import { createWorkHubInspectionTool } from '../server/workhub-inspection-tool.js';
import { createSessionTranscriptReader } from '../server/session-transcript-reader.js';
import { SessionAdmissionGate } from '../server/session-admission-gate.js';
import { transcriptReader } from './fixtures/session-transcript-reader.js';

type Options = Parameters<typeof createWorkHubInspectionTool>[0];
const context: MakaToolContext = {
  sessionId: WORKHUB_COORDINATION_SESSION_ID,
  turnId: 'coord-turn',
  runId: 'coord-run',
  toolCallId: 'inspect',
  cwd: '/workspace',
  abortSignal: new AbortController().signal,
  emitOutput() {},
};
function session(id = 'target'): Awaited<ReturnType<Options['listSessions']>>[number] {
  return {
    id,
    name: 'Release',
    cwd: `/work/${id}`,
    createdAt: 1,
    lastMessageAt: 10,
    statusUpdatedAt: 1,
    status: 'active',
    labels: [],
    isArchived: false,
  };
}
function assistant(text: string, id = 'reply', turnId = 'target-turn'): StoredMessage {
  return {
    type: 'assistant',
    id,
    turnId,
    ts: 3,
    text,
    modelId: 'test',
    thinking: { text: 'private reasoning is not conversation text' },
  };
}
function user(text: string, id = 'request'): StoredMessage {
  return { type: 'user', id, turnId: 'target-turn', ts: 2, text };
}
function fixture(
  messages: StoredMessage[] = [
    user('Release it'),
    assistant('Tests passed; publishing is pending.'),
  ],
) {
  let sessions = [session(), session('other')];
  let execution: Awaited<ReturnType<Options['readExecution']>> = {
    sessionId: 'target',
    turnId: 'target-turn',
    runId: 'target-run',
    status: 'completed',
  };
  const baseReader = transcriptReader(messages);
  const requests: Parameters<Options['reader']['readDurableRecords']>[1][] = [];
  let afterRead = () => {};
  const reader: Options['reader'] = {
    readDurableHighWater: baseReader.readDurableHighWater,
    readDurableRecords: async (sessionId, request) => {
      requests.push(request);
      const page = await baseReader.readDurableRecords(sessionId, request);
      afterRead();
      return page;
    },
  };
  const options: Options = {
    listSessions: async () => sessions,
    reader,
    admission: new SessionAdmissionGate(),
    readExecution: async () => execution,
  };
  const tool = createWorkHubInspectionTool(options);
  const call = (input: Record<string, unknown> = {}, ctx = context) =>
    tool.impl(tool.parameters.parse({ sessionId: 'target', ...input }), ctx);
  const read = async (input: Record<string, unknown> = {}) => {
    const result = await call(input);
    if (result.status !== 'ok') assert.fail(result.reason);
    return result;
  };
  return {
    call,
    read,
    tool,
    options,
    requests,
    messages,
    sessions: () => sessions,
    setSessions: (next: typeof sessions) => {
      sessions = next;
    },
    setExecution: (next: typeof execution) => {
      execution = next;
    },
    afterRead: (callback: () => void) => {
      afterRead = callback;
    },
  };
}

test('WorkHubInspect returns source text/identities and keeps execution completion separate', async () => {
  const messages = [
    { ...user('internal transport wrapper'), displayText: 'Release it' },
    assistant('Tests passed; publishing is pending.'),
  ] as StoredMessage[];
  const f = fixture(messages);
  const before = structuredClone(messages);
  const result = await f.read();
  assert.equal(result.sessionId, 'target');
  assert.deepEqual(result.workspace, {
    target: { kind: 'host_path', path: '/work/target' },
    hostCwd: '/work/target',
  });
  assert.deepEqual(
    result.transcript.messages.map((m) => [m.messageId, m.turnId, m.timestamp, m.text]),
    [
      ['reply', 'target-turn', 3, 'Tests passed; publishing is pending.'],
      ['request', 'target-turn', 2, 'Release it'],
    ],
  );
  assert.equal(result.executionEvidence.status, 'completed');
  assert.equal(result.executionEvidence.scope, 'latest_root_turn');
  assert.equal(result.executionEvidence.artifactsVerified, false);
  assert.equal(result.transcript.nextCursor, null);
  assert.doesNotMatch(JSON.stringify(result), /private reasoning|internal transport wrapper/);
  assert.deepEqual(messages, before);
  f.setExecution({
    sessionId: 'target',
    turnId: 'new-turn',
    runId: 'new-run',
    status: 'waiting_for_user',
  });
  const waiting = await f.read();
  assert.equal(waiting.executionEvidence.turnId, 'new-turn');
  assert.equal(waiting.transcript.messages[0]!.turnId, 'target-turn');
  assert.equal(waiting.executionEvidence.completionVerified, false);
  f.setExecution(null);
  assert.equal((await f.read()).executionEvidence.status, null);
});

test('WorkHubInspect reconstructs an oversized Unicode reply across a fixed snapshot', async () => {
  const text = 'x'.repeat(255) + '😀汉字'.repeat(350) + ' final';
  const f = fixture([user('question'), assistant('old', 'older'), assistant(text)]);
  const before = structuredClone(f.messages);
  let page = await f.read({ view: 'latest_reply', maxTextChars: 256 });
  const watermark = page.transcript.throughSequence;
  assert.equal(page.transcript.messages[0]!.text.length, 255);
  assert.equal(page.transcript.messages[0]!.truncated, true);
  // Neither new activity nor a changed presentation label may shift this cursor.
  f.messages.push(assistant('new reply must not enter the snapshot', 'new'));
  f.setSessions(f.sessions().map((s) => ({ ...s, name: 'Renamed' })));
  let reconstructed = '';
  let pages = 0;
  for (;;) {
    assert.equal(page.transcript.throughSequence, watermark);
    for (const message of page.transcript.messages) {
      assert.equal(message.messageId, 'reply');
      assert.equal(message.textOffset, reconstructed.length);
      assert.equal(Buffer.from(message.text).toString('utf8'), message.text);
      reconstructed += message.text;
    }
    const cursor = page.transcript.nextCursor;
    if (!cursor) break;
    assert.ok(++pages < 30);
    page = await f.read({ view: 'latest_reply', maxTextChars: 256, cursor });
  }
  assert.equal(reconstructed, text);
  assert.deepEqual(f.messages.slice(0, -1), before);
  assert.equal((await f.read({ view: 'latest_reply' })).transcript.messages[0]!.messageId, 'new');
});

test('recent pagination preserves every visible message and splits long messages without gaps', async () => {
  const f = fixture([
    user('old', 'old-user'),
    assistant('😀'.repeat(600), 'long'),
    user('new', 'new-user'),
    assistant('latest'),
  ]);
  const observed = new Map<string, string>();
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = await f.read({ maxMessages: 1, maxTextChars: 257, ...(cursor ? { cursor } : {}) });
    for (const message of page.transcript.messages) {
      const prior = observed.get(message.messageId) ?? '';
      assert.equal(message.textOffset, prior.length);
      observed.set(message.messageId, prior + message.text);
    }
    cursor = page.transcript.nextCursor ?? undefined;
    assert.ok(++pages < 15);
  } while (cursor);
  assert.deepEqual(
    [...observed],
    [
      ['reply', 'latest'],
      ['new-user', 'new'],
      ['long', '😀'.repeat(600)],
      ['old-user', 'old'],
    ],
  );
});

test('bounded scans can continue past tool records without presenting a false empty reply', async () => {
  const hidden: StoredMessage[] = Array.from({ length: 130 }, (_, i) => ({
    type: 'tool_call',
    id: `tool-${i}`,
    turnId: 'target-turn',
    ts: 4 + i,
    toolName: 'Bash',
    args: { command: 'private tool input' },
  }));
  const f = fixture([assistant('the last actual reply'), ...hidden]);
  let page = await f.read({ view: 'latest_reply' });
  assert.equal(page.transcript.messages.length, 0);
  assert.ok(page.transcript.nextCursor);
  let pages = 1;
  while (page.transcript.nextCursor) {
    page = await f.read({ view: 'latest_reply', cursor: page.transcript.nextCursor });
    pages++;
  }
  assert.equal(pages, 3);
  assert.equal(page.transcript.messages[0]!.text, 'the last actual reply');
  assert.ok(f.requests.every((r) => r.maxMessages === 64 && r.maxStoredBytes === 256 * 1024));
});

test('cursors reject tampering, target/view changes and a new Host instance', async () => {
  const f = fixture([assistant('a'.repeat(1000))]);
  const cursor = (await f.read({ view: 'latest_reply', maxTextChars: 256 })).transcript.nextCursor!;
  await assert.rejects(
    f.call({ cursor: `x${cursor}`, view: 'latest_reply' }),
    /Invalid or expired/,
  );
  await assert.rejects(f.call({ cursor, view: 'recent' }), /Invalid or expired/);
  await assert.rejects(
    f.call({ sessionId: 'other', cursor, view: 'latest_reply' }),
    /Invalid or expired/,
  );
  const restarted = createWorkHubInspectionTool(f.options);
  await assert.rejects(
    restarted.impl(
      restarted.parameters.parse({ sessionId: 'target', cursor, view: 'latest_reply' }),
      context,
    ),
    /Invalid or expired/,
  );
});

test('every page enforces current candidate eligibility and rejects other callers', async () => {
  const f = fixture([assistant('a'.repeat(1000))]);
  const cursor = (await f.read({ view: 'latest_reply', maxTextChars: 256 })).transcript.nextCursor!;
  const reads = f.requests.length;
  for (const sessions of [
    [],
    [{ ...session(), isArchived: true }],
    [{ ...session(), role: 'workhub_coordination' as const }],
    [{ ...session(), labels: ['mode:side_conversation'] }],
    [{ ...session(), subagentParent: { sessionId: 'parent' } }],
    [
      session(),
      ...Array.from({ length: 32 }, (_, i) => ({
        ...session(`recent-${i}`),
        lastMessageAt: 100 + i,
      })),
    ],
  ]) {
    f.setSessions(sessions as ReturnType<typeof f.sessions>);
    assert.equal((await f.call({ cursor, view: 'latest_reply' })).status, 'unavailable');
  }
  assert.equal(f.requests.length, reads);
  f.setSessions([session()]);
  await assert.rejects(f.call({}, { ...context, sessionId: 'ordinary' }), /requires the WorkHub/);
  assert.equal(f.requests.length, reads);
  const aborted = new AbortController();
  aborted.abort(new Error('cancelled read'));
  await assert.rejects(f.call({}, { ...context, abortSignal: aborted.signal }), /cancelled read/);
  assert.equal(f.requests.length, reads);
});

test('scope changes during a read suppress the returned source; malformed reads fail explicitly', async () => {
  const f = fixture();
  f.afterRead(() => f.setSessions([]));
  assert.equal((await f.call()).status, 'unavailable');
  f.setSessions([session()]);
  f.afterRead(() => {});
  f.options.reader.readDurableRecords = async () => {
    throw new Error('corrupt transcript');
  };
  await assert.rejects(f.call(), /corrupt transcript/);
});

test('inspection freezes durable replies while a Turn is running without mutating the target', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-workhub-inspect-'));
  const capability = await resolveStorageRoot({ path: join(base, 'root'), kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
  try {
    const target = await stores.sessionStore.create({
      cwd: base,
      name: 'Release',
      llmConnectionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      llmConnectionSlug: 'fake',
      model: 'test',
      permissionMode: 'ask',
    });
    await seedInvocation(stores.runtimeEventStore, {
      sessionId: target.id,
      turnId: 'target-turn',
      runId: 'target-run',
      openedAt: 1,
    });
    const event = (id: string, overrides: Partial<RuntimeEvent>): RuntimeEvent => ({
      partial: false,
      id,
      sessionId: target.id,
      invocationId: 'target-run',
      runId: 'target-run',
      turnId: 'target-turn',
      ts: 2,
      author: 'agent',
      role: 'model',
      ...overrides,
    });
    await stores.runtimeEventStore.appendRuntimeEvent(
      target.id,
      'target-run',
      event('user-event', {
        author: 'user',
        role: 'user',
        content: { kind: 'text', text: 'Please report progress' },
        refs: { storedMessageId: 'request' },
      }),
    );
    const text = '😀'.repeat(400);
    await stores.runtimeEventStore.appendRuntimeEvent(
      target.id,
      'target-run',
      event('committed-reply', {
        content: { kind: 'text', text },
        refs: { providerEventId: 'reply' },
      }),
    );
    const reader = createSessionTranscriptReader({
      stores,
      canonicalPermissionOutcomes: { readPermissionOutcome: async () => undefined },
    });
    const headerBefore = await stores.sessionStore.readHeaderRecordSnapshot(target.id);
    const tool = createWorkHubInspectionTool({
      listSessions: () => stores.sessionStore.listHeaders(),
      reader,
      admission: new SessionAdmissionGate(),
      readExecution: async () => ({
        sessionId: target.id,
        turnId: 'target-turn',
        runId: 'target-run',
        status: 'running',
      }),
    });
    const call = async (cursor?: string) => {
      const result = await tool.impl(
        tool.parameters.parse({
          sessionId: target.id,
          view: 'latest_reply',
          maxTextChars: 256,
          ...(cursor ? { cursor } : {}),
        }),
        context,
      );
      if (result.status !== 'ok') assert.fail(result.reason);
      return result;
    };
    let page = await call();
    assert.equal(page.executionEvidence.status, 'running');
    const watermark = page.transcript.throughSequence;
    await stores.runtimeEventStore.appendRuntimeEvent(
      target.id,
      'target-run',
      event('later-partial', {
        partial: true,
        ts: 3,
        content: { kind: 'text', text: 'LATER' },
        refs: { providerEventId: 'reply' },
      }),
    );
    // New committed text must not enter an already-issued cursor's snapshot.
    await stores.runtimeEventStore.appendRuntimeEvent(
      target.id,
      'target-run',
      event('later-reply', {
        ts: 4,
        content: { kind: 'text', text: 'New committed answer' },
        refs: { providerEventId: 'new-reply' },
      }),
    );
    const afterAppend = await reader.readDurableHighWater(target.id);
    let reconstructed = '';
    for (;;) {
      assert.equal(page.transcript.throughSequence, watermark);
      reconstructed += page.transcript.messages.map((m) => m.text).join('');
      if (!page.transcript.nextCursor) break;
      page = await call(page.transcript.nextCursor);
    }
    assert.equal(reconstructed, text);
    assert.equal((await call()).transcript.messages[0]?.text, 'New committed answer');
    assert.equal(await reader.readDurableHighWater(target.id), afterAppend);
    assert.deepEqual(await stores.sessionStore.readHeaderRecordSnapshot(target.id), headerBefore);
    assert.equal(
      await stores.agentRunStore.readRootTurnAdmission(target.id, 'target-turn'),
      undefined,
    );
  } finally {
    await stores.sessionStore.close?.();
    await owner.close();
    await rm(base, { recursive: true, force: true });
  }
});

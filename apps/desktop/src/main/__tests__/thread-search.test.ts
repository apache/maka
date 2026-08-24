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

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { SessionSummary, StoredMessage } from '@maka/core/session';
import {
  SNIPPET_MAX_CODE_POINTS,
  TOOL_RESULT_SCAN_CAP_BYTES,
  capCodePoints,
  collectSearchableText,
  findMatch,
  foldForMatch,
  runThreadSearch,
} from '../search/thread-search.js';

type Entry = { session: SessionSummary; messages: StoredMessage[] };
type SearchOutcome = Awaited<ReturnType<typeof runThreadSearch>>;

function session(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
  return {
    name: overrides.id,
    isFlagged: false,
    isArchived: false,
    labels: [],
    hasUnread: false,
    status: 'active',
    backend: 'ai-sdk',
    llmConnectionSlug: 'anthropic',
    connectionLocked: false,
    model: 'claude-sonnet-4-5-20250929',
    permissionMode: 'ask',
    lastMessageAt: 1_700_000_000_000,
    ...overrides,
  };
}

function userMessage(text: string, turnId = 't1', id = 'u1'): StoredMessage {
  return { type: 'user', id, turnId, ts: 1_700_000_000_000, text };
}

function assistantMessage(
  text: string,
  thinking?: string,
  turnId = 't1',
): Extract<StoredMessage, { type: 'assistant' }> {
  return {
    type: 'assistant',
    id: 'a1',
    turnId,
    ts: 1_700_000_000_000,
    text,
    modelId: 'glm-4.7',
    ...(thinking ? { thinking: { text: thinking } } : {}),
  };
}

function toolCall(intent?: string): Extract<StoredMessage, { type: 'tool_call' }> {
  return {
    type: 'tool_call',
    id: 'tc1',
    turnId: 't1',
    ts: 1_700_000_000_000,
    toolName: 'Bash',
    displayName: 'Shell command',
    intent,
    args: {},
  };
}

function toolResult(content: unknown, isError = false): Extract<StoredMessage, { type: 'tool_result' }> {
  return {
    type: 'tool_result',
    id: 'tr1',
    turnId: 't1',
    ts: 1_700_000_000_000,
    toolUseId: 'call1',
    isError,
    content: content as never,
  };
}

function makeDeps(entries: Record<string, Entry>, privacyPayload: unknown = { incognitoActive: false }) {
  return {
    async listSessions() {
      return Object.values(entries).map((entry) => entry.session);
    },
    async readMessages(sessionId: string) {
      return entries[sessionId]?.messages ?? [];
    },
    async getPrivacyContext() {
      return privacyPayload;
    },
  };
}

function expectResults(outcome: SearchOutcome) {
  if (!outcome.ok) assert.fail(`expected results, got ${outcome.reason}`);
  return outcome.results;
}

describe('runThreadSearch', () => {
  it('fails closed for malformed requests and unsupported sources', async () => {
    const cases: Array<[unknown, 'invalid_query' | 'disabled']> = [
      [null, 'invalid_query'],
      [undefined, 'invalid_query'],
      ['hello', 'invalid_query'],
      [[], 'invalid_query'],
      [{ query: 'hello', limit: 5 }, 'disabled'],
      [{ source: 'web', query: 'hello', limit: 5 }, 'disabled'],
      [{ source: 'thread', limit: 5 }, 'invalid_query'],
      [{ source: 'thread', query: 42, limit: 5 }, 'invalid_query'],
      [{ source: 'thread', query: '   ', limit: 5 }, 'invalid_query'],
    ];
    for (const [request, reason] of cases) {
      const outcome = await runThreadSearch(request, makeDeps({}));
      assert.equal(outcome.ok, false);
      if (!outcome.ok) assert.equal(outcome.reason, reason);
    }
  });

  it('clamps results to the shared maximum and marks truncation', async () => {
    const entries: Record<string, Entry> = {};
    for (let index = 0; index < 15; index++) {
      const id = `s${String(index).padStart(2, '0')}`;
      entries[id] = {
        session: session({ id, lastMessageAt: 1_700_000_000_000 - index }),
        messages: [userMessage('hello world')],
      };
    }
    const hits = expectResults(
      await runThreadSearch({ source: 'thread', query: 'hello', limit: 50 }, makeDeps(entries)),
    );
    assert.equal(hits.length, 10);
    assert.equal(hits.at(-1)?.truncated, true);
  });

  it('continues beyond the session scan ceiling without gaps', async () => {
    const entries: Record<string, Entry> = {};
    for (let index = 0; index < 201; index += 1) {
      const id = `session-${String(index).padStart(3, '0')}`;
      entries[id] = {
        // The stable id tie-breaker is part of the cursor contract.
        session: session({ id, lastMessageAt: 10_000 }),
        messages: index === 200 ? [userMessage('only-oldest-match')] : [],
      };
    }
    const first = await runThreadSearch(
      { source: 'thread', query: 'only-oldest-match', limit: 5 },
      makeDeps(entries),
    );
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.deepEqual(first.results, []);
    assert.equal(first.truncated, true);
    assert.equal(typeof first.nextCursor, 'string');

    const second = await runThreadSearch(
      {
        source: 'thread',
        query: 'only-oldest-match',
        limit: 5,
        cursor: first.nextCursor,
      },
      makeDeps(entries),
    );
    assert.equal(second.ok, true);
    if (!second.ok) return;
    assert.deepEqual(
      second.results.map((result) =>
        result.target?.kind === 'thread' ? result.target.sessionId : undefined,
      ),
      ['session-200'],
    );
    assert.equal(second.truncated, false);
    assert.equal(second.nextCursor, undefined);

    const mismatched = await runThreadSearch(
      { source: 'thread', query: 'another-query', limit: 5, cursor: first.nextCursor },
      makeDeps(entries),
    );
    assert.equal(mismatched.ok, false);
    if (!mismatched.ok) assert.equal(mismatched.reason, 'invalid_query');
  });

  it('checks cancellation between transcript reads', async () => {
    const controller = new AbortController();
    let reads = 0;
    const outcome = await runThreadSearch(
      { source: 'thread', query: 'needle', limit: 5 },
      {
        ...makeDeps({
          newest: { session: session({ id: 'newest', lastMessageAt: 2 }), messages: [] },
          older: {
            session: session({ id: 'older', lastMessageAt: 1 }),
            messages: [userMessage('needle')],
          },
        }),
        async readMessages(sessionId, signal) {
          reads += 1;
          assert.equal(signal, controller.signal);
          if (sessionId === 'newest') controller.abort();
          return [];
        },
      },
      { abortSignal: controller.signal },
    );
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.equal(outcome.reason, 'aborted');
    assert.equal(reads, 1);
  });

  it('yields to cancellation while scanning a large transcript', async () => {
    const controller = new AbortController();
    const messages = Array.from({ length: 2_000 }, (_, index) =>
      userMessage(`ordinary message ${index}`, `turn-${index}`, `message-${index}`),
    );
    setImmediate(() => controller.abort());
    const outcome = await runThreadSearch(
      { source: 'thread', query: 'missing needle', limit: 5 },
      makeDeps({ large: { session: session({ id: 'large' }), messages } }),
      { abortSignal: controller.signal },
    );
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.equal(outcome.reason, 'aborted');
  });

  it('excludes the active Turn only inside the active Session', async () => {
    const hits = expectResults(
      await runThreadSearch(
        { source: 'thread', query: 'copied text', limit: 10 },
        makeDeps({
          active: {
            session: session({ id: 'active', lastMessageAt: 2 }),
            messages: [userMessage('copied text active', 'shared-turn', 'active-message')],
          },
          branch: {
            session: session({ id: 'branch', lastMessageAt: 1 }),
            messages: [userMessage('copied text branch', 'shared-turn', 'branch-message')],
          },
        }),
        { activeSessionId: 'active', excludeTurnIds: new Set(['shared-turn']) },
      ),
    );
    assert.deepEqual(
      hits.map((hit) => (hit.target?.kind === 'thread' ? hit.target.sessionId : undefined)),
      ['branch'],
    );
  });

  it('redacts snippets and excludes fake-backend and archived sessions', async () => {
    const hits = expectResults(
      await runThreadSearch(
        { source: 'thread', query: 'hello', limit: 5 },
        makeDeps({
          fake: {
            session: session({ id: 'fake', backend: 'fake' }),
            messages: [userMessage('hello from fixture')],
          },
          // Archiving a task takes it out of the working set. It has no rail
          // row to land on, so a hit inside it can only be opened from a
          // surface that no longer exists; Settings manages it instead.
          archived: {
            session: session({ id: 'archived', isArchived: true }),
            messages: [userMessage('hello from an archived task')],
          },
          real: {
            session: session({ id: 'real' }),
            messages: [userMessage('hello sk-ant-test-secret-token-12345 world')],
          },
        }),
      ),
    );
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.target?.kind === 'thread' && hits[0].target.sessionId, 'real');
    assert.match(hits[0]?.snippet ?? '', /\[redacted\]/);
    assert.equal(hits[0]?.snippet?.includes('sk-ant-test-secret-token-12345'), false);
  });

  it('matches only redacted projections and rejects secret-shaped queries', async () => {
    const entries = {
      title: {
        session: session({ id: 'title', name: 'password=title-secret-value' }),
        messages: [],
      },
      message: {
        session: session({ id: 'message' }),
        messages: [userMessage('token=message-secret-value')],
      },
      intent: {
        session: session({ id: 'intent' }),
        messages: [toolCall('api_key=intent-secret-value')],
      },
      result: {
        session: session({ id: 'result' }),
        messages: [toolResult({ password: 'result-secret-value' })],
      },
    };

    for (const query of [
      'title-secret-value',
      'title-wrong-value',
      'message-secret-value',
      'message-wrong-value',
      'intent-secret-value',
      'intent-wrong-value',
      'result-secret-value',
      'result-wrong-value',
    ]) {
      assert.deepEqual(
        expectResults(
          await runThreadSearch({ source: 'thread', query, limit: 10 }, makeDeps(entries)),
        ),
        [],
      );
    }

    for (const query of [
      'sk-ant-correctsecret12345678',
      'sk-ant-wrongsecret123456789',
    ]) {
      const outcome = await runThreadSearch(
        { source: 'thread', query, limit: 5 },
        makeDeps(entries),
      );
      assert.equal(outcome.ok, false);
      if (!outcome.ok) assert.equal(outcome.reason, 'invalid_query');
    }
  });

  it('includes archived sessions only when the caller explicitly opts in', async () => {
    const entries = {
      archived: {
        session: session({ id: 'archived', isArchived: true }),
        messages: [userMessage('archived needle')],
      },
    };
    assert.deepEqual(
      expectResults(
        await runThreadSearch(
          { source: 'thread', query: 'archived needle', limit: 5 },
          makeDeps(entries),
        ),
      ),
      [],
    );
    const optedIn = expectResults(
      await runThreadSearch(
        { source: 'thread', query: 'archived needle', limit: 5 },
        makeDeps(entries),
        { includeArchived: true },
      ),
    );
    assert.equal(optedIn[0]?.target?.kind === 'thread' && optedIn[0].target.sessionId, 'archived');
  });

  it('searches only the current committed conversation revision', async () => {
    const hits = expectResults(
      await runThreadSearch(
        { source: 'thread', query: 'shared-match', limit: 10 },
        makeDeps({
          root: {
            session: session({ id: 'root', lastMessageAt: 10 }),
            messages: [userMessage('shared-match old version')],
          },
          revision: {
            session: session({
              id: 'revision',
              revisionRootSessionId: 'root',
              revisionParentSessionId: 'root',
              revisionIndex: 2,
              revisionState: 'committed',
              lastMessageAt: 20,
            }),
            messages: [userMessage('shared-match current version')],
          },
          preparing: {
            session: session({
              id: 'preparing',
              revisionRootSessionId: 'root',
              revisionParentSessionId: 'revision',
              revisionIndex: 3,
              revisionState: 'preparing',
              lastMessageAt: 30,
            }),
            messages: [userMessage('shared-match uncommitted version')],
          },
        }),
      ),
    );
    assert.deepEqual(
      hits.map((hit) => (hit.target?.kind === 'thread' ? hit.target.sessionId : undefined)),
      ['revision'],
    );
  });

  it('returns navigable title and transcript results without synthetic URLs', async () => {
    const entries = {
      s1: {
        session: session({
          id: 's1',
          name: 'Maka roadmap sk-ant-test-secret-token-12345 planning',
        }),
        messages: [userMessage('diagnostic from user', 'turn-user')],
      },
    };
    const titleHit = expectResults(
      await runThreadSearch({ source: 'thread', query: 'roadmap', limit: 5 }, makeDeps(entries)),
    )[0]!;
    assert.deepEqual(titleHit.target, {
      kind: 'thread',
      sessionId: 's1',
      matchKind: 'session_title',
    });
    assert.equal(titleHit.summary, '任务标题');
    assert.equal(titleHit.url, undefined);
    assert.match(titleHit.snippet ?? '', /\[redacted\]/);
    assert.equal(titleHit.snippet?.includes('sk-ant-test-secret-token-12345'), false);

    const messageHit = expectResults(
      await runThreadSearch({ source: 'thread', query: 'diagnostic', limit: 5 }, makeDeps(entries)),
    )[0]!;
    assert.deepEqual(messageHit.target, {
      kind: 'thread',
      sessionId: 's1',
      turnId: 'turn-user',
      sequence: 0,
      messageId: 'u1',
      matchKind: 'user_message',
      messageTimestamp: 1_700_000_000_000,
    });
    assert.equal(messageHit.summary, '用户消息');
    assert.equal(messageHit.url, undefined);
  });

  it('skips a transcript that its dependency could not read', async () => {
    const entries = {
      s1: { session: session({ id: 's1' }), messages: [] },
    };
    const deps = makeDeps(entries);

    assert.deepEqual(
      expectResults(
        await runThreadSearch(
        { source: 'thread', query: 'diagnostic', limit: 5 },
        { ...deps, readMessages: async () => null },
        ),
      ),
      [],
    );
  });

  it('blocks active or unverifiable privacy state before scanning', async () => {
    for (const privacyPayload of [
      { incognitoActive: true },
      null,
      {},
      { incognitoActive: 'true' },
      'invalid',
      [],
    ]) {
      let listCalls = 0;
      let readCalls = 0;
      const base = makeDeps({}, privacyPayload);
      const outcome = await runThreadSearch(
        { source: 'thread', query: 'hello', limit: 5 },
        {
          ...base,
          async listSessions() {
            listCalls++;
            return [];
          },
          async readMessages() {
            readCalls++;
            return [];
          },
        },
      );
      assert.equal(outcome.ok, false);
      if (!outcome.ok) {
        assert.equal(outcome.reason, 'incognito_active');
        assert.match(
          outcome.message,
          privacyPayload && !Array.isArray(privacyPayload) &&
            typeof privacyPayload === 'object' &&
            (privacyPayload as { incognitoActive?: unknown }).incognitoActive === true
            ? /incognito is active/
            : /could not be verified/,
        );
      }
      assert.deepEqual({ listCalls, readCalls }, { listCalls: 0, readCalls: 0 });
    }
  });
});

describe('thread search text projection', () => {
  it('normalizes case and NFC and caps snippets by code point', () => {
    assert.equal(foldForMatch('HELLO'), 'hello');
    assert.equal(foldForMatch('Héllo'), foldForMatch('Héllo'));
    assert.equal(findMatch('hello world', foldForMatch('WORLD')), 6);

    const capped = capCodePoints(`${'a'.repeat(500)}🦊`, SNIPPET_MAX_CODE_POINTS);
    assert.equal(Array.from(capped).length, SNIPPET_MAX_CODE_POINTS);
    assert.ok(capped.endsWith('…'));
  });

  it('bounds and classifies serialized tool results', async () => {
    assert.equal(collectSearchableText(toolResult({ result: 'short' })), '{"result":"short"}');
    const extracted = collectSearchableText(toolResult({ data: 'X'.repeat(100_000) }));
    assert.ok(extracted);
    assert.ok(Buffer.byteLength(extracted, 'utf8') <= TOOL_RESULT_SCAN_CAP_BYTES);

    const hits = expectResults(
      await runThreadSearch(
        { source: 'thread', query: 'short', limit: 5 },
        makeDeps({
          s1: { session: session({ id: 's1' }), messages: [toolResult({ result: 'short' })] },
        }),
      ),
    );
    assert.equal(hits[0]?.target?.matchKind, 'tool_result');
    assert.equal(hits[0]?.target?.messageId, 'tr1');
  });

  it('indexes tool intent but not tool names or display names', async () => {
    assert.equal(collectSearchableText(toolCall('check disk usage')), 'check disk usage');
    assert.equal(collectSearchableText(toolCall()), undefined);

    const entries = {
      s1: { session: session({ id: 's1' }), messages: [toolCall('check disk usage on /var')] },
    };
    for (const query of ['Bash', 'Shell command']) {
      assert.deepEqual(
        expectResults(
          await runThreadSearch({ source: 'thread', query, limit: 5 }, makeDeps(entries)),
        ),
        [],
      );
    }
    const hits = expectResults(
      await runThreadSearch(
        { source: 'thread', query: 'disk usage', limit: 5 },
        makeDeps(entries),
      ),
    );
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.target?.matchKind, 'tool_intent');
    assert.equal(hits[0]?.target?.messageId, 'tc1');
  });

  it('indexes assistant answers without exposing thinking', async () => {
    const message = assistantMessage(
      'this is the visible answer',
      'private reasoning path: greeting me in Chinese',
    );
    assert.equal(collectSearchableText(message), 'this is the visible answer');

    const entries = { s1: { session: session({ id: 's1' }), messages: [message] } };
    assert.equal(
      expectResults(
        await runThreadSearch(
          { source: 'thread', query: 'private reasoning', limit: 5 },
          makeDeps(entries),
        ),
      ).length,
      0,
    );
    const visible = expectResults(
      await runThreadSearch(
        { source: 'thread', query: 'visible answer', limit: 5 },
        makeDeps(entries),
      ),
    );
    assert.equal(visible.length, 1);
    assert.equal(visible[0]?.target?.matchKind, 'assistant_message');
    assert.equal(visible[0]?.target?.messageId, 'a1');
    assert.equal(visible[0]?.snippet?.includes('private reasoning'), false);
  });

  it('excludes system, token, turn-state, and permission records', () => {
    const excluded: StoredMessage[] = [
      {
        type: 'system_note',
        id: 'sn1',
        ts: 1,
        kind: 'session_start',
        data: { note: 'private' },
      },
      { type: 'token_usage', id: 'tk1', turnId: 't1', ts: 1, input: 1, output: 2 },
      {
        type: 'turn_state',
        id: 'ts1',
        turnId: 't1',
        ts: 1,
        status: 'completed',
        partialOutputRetained: false,
      },
      {
        type: 'permission_decision',
        id: 'pd1',
        turnId: 't1',
        ts: 1,
        toolUseId: 'call1',
        toolName: 'Bash',
        decision: 'allow',
      },
    ];
    for (const message of excluded) assert.equal(collectSearchableText(message), undefined);
  });

});

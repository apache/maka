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
  if (!Array.isArray(outcome)) assert.fail(`expected results, got ${outcome.reason}`);
  return outcome;
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
      assert.equal(Array.isArray(outcome), false);
      if (!Array.isArray(outcome)) assert.equal(outcome.reason, reason);
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

  it('redacts snippets and excludes fake-backend sessions', async () => {
    const hits = expectResults(
      await runThreadSearch(
        { source: 'thread', query: 'hello', limit: 5 },
        makeDeps({
          fake: {
            session: session({ id: 'fake', backend: 'fake' }),
            messages: [userMessage('hello from fixture')],
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
    assert.deepEqual(titleHit.target, { kind: 'thread', sessionId: 's1' });
    assert.equal(titleHit.summary, '会话标题');
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
      await runThreadSearch(
        { source: 'thread', query: 'diagnostic', limit: 5 },
        { ...deps, readMessages: async () => null },
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
      assert.equal(Array.isArray(outcome), false);
      if (!Array.isArray(outcome)) {
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

  it('bounds serialized tool results', () => {
    assert.equal(collectSearchableText(toolResult({ result: 'short' })), '{"result":"short"}');
    const extracted = collectSearchableText(toolResult({ data: 'X'.repeat(100_000) }));
    assert.ok(extracted);
    assert.ok(Buffer.byteLength(extracted, 'utf8') <= TOOL_RESULT_SCAN_CAP_BYTES);
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
    assert.equal(
      expectResults(
        await runThreadSearch(
          { source: 'thread', query: 'disk usage', limit: 5 },
          makeDeps(entries),
        ),
      ).length,
      1,
    );
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

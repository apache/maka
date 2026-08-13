import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SessionSummary, StoredMessage } from '@maka/core/session';
import type { ZodType } from 'zod';
import {
  buildHistoryTools,
  buildReadHistoryTool,
  buildSearchHistoryTool,
  HISTORY_READ_MAX_BYTES,
} from '../history-tools.js';
import type { MakaToolContext } from '../tool-runtime.js';

test('history tools expose strict global-search and anchored-read schemas', () => {
  const deps = historyDeps([], new Map());
  const tools = buildHistoryTools(deps);
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ['SearchHistory', 'ReadHistory'],
  );

  const search = tools[0]!.parameters as ZodType;
  const read = tools[1]!.parameters as ZodType;
  assert.deepEqual(search.parse({ query: 'release notes' }), { query: 'release notes' });
  assert.throws(() => search.parse({ query: '', session_id: 'past' }));
  assert.deepEqual(
    read.parse({
      session_id: 'past',
      message_id: 'assistant-turn-1',
      turn_id: 'turn-1',
      before: 1,
      after: 1,
    }),
    {
      session_id: 'past',
      message_id: 'assistant-turn-1',
      turn_id: 'turn-1',
      before: 1,
      after: 1,
    },
  );
  assert.throws(() => read.parse({ session_id: 'past', before: 4, after: 4 }));
  assert.throws(() => read.parse({ session_id: 'past', max_turns: 2 }));
});

test('SearchHistory returns typed message hits from current and other sessions', async () => {
  const sessions = [
    { ...session('current', 'Current session', 3), revisionRootSessionId: 'current-family' },
    {
      ...session('current-newer-revision', 'Current newer revision', 4),
      revisionRootSessionId: 'current-family',
      revisionParentSessionId: 'current',
      revisionState: 'committed' as const,
    },
    session('past', 'Deployment sk-ant-title-secret-12345 work', 2),
    session('fixture', 'Fixture', 1, 'fake'),
  ];
  const messages = new Map<string, StoredMessage[]>([
    [
      'current',
      [
        user('deploy from an older current-session turn', 'current-old-turn'),
        user('deploy from the active turn must not match itself', 'current-turn'),
      ],
    ],
    ['current-newer-revision', [user('deploy sibling revision', 'sibling-turn')]],
    [
      'past',
      [
        user('Please deploy the service with token sk-ant-test-secret-token-12345', 'past-turn'),
        assistant('Deployment completed.', 'past-turn'),
      ],
    ],
    ['fixture', [user('deploy fixture', 'fixture-turn')]],
  ]);
  const tool = buildSearchHistoryTool(historyDeps(sessions, messages));

  const result = (await tool.impl({ query: 'deploy', limit: 10 }, context())) as {
    kind: string;
    truncated: boolean;
    rows: Array<Record<string, unknown>>;
  };

  assert.equal(result.kind, 'history_search');
  assert.equal(result.truncated, false);
  assert.ok(result.rows.length > 0);
  assert.deepEqual(new Set(result.rows.map((row) => row.session_id)), new Set(['current', 'past']));
  assert.ok(result.rows.every((row) => row.session_id !== 'current-newer-revision'));
  const messageRows = result.rows.filter((row) => row.match_kind !== 'session_title');
  assert.ok(messageRows.every((row) => typeof row.message_id === 'string'));
  assert.ok(messageRows.every((row) => typeof row.message_timestamp === 'number'));
  assert.deepEqual(
    new Set(result.rows.map((row) => row.match_kind)),
    new Set(['session_title', 'user_message', 'assistant_message']),
  );
  assert.equal(result.rows.find((row) => row.session_id === 'current')?.is_current_session, true);
  assert.ok(result.rows.every((row) => row.turn_id !== 'current-turn'));
  assert.ok(
    result.rows
      .filter((row) => row.session_id === 'past')
      .every((row) => row.is_current_session === false),
  );
  assert.match(JSON.stringify(result.rows), /\[redacted\]/u);
  assert.doesNotMatch(JSON.stringify(result.rows), /sk-ant-test-secret-token-12345/u);
});

test('ReadHistory returns a bounded visible excerpt without reasoning or raw tool data', async () => {
  const huge = `finished ${'x'.repeat(HISTORY_READ_MAX_BYTES * 2)}`;
  const messages = new Map<string, StoredMessage[]>([
    [
      'past',
      [
        user('Use token sk-ant-test-secret-token-12345', 'turn-1'),
        {
          type: 'assistant',
          id: 'assistant-thinking',
          turnId: 'turn-1',
          ts: 2,
          text: huge,
          thinking: { text: 'private chain of thought' },
          modelId: 'test-model',
        },
        {
          type: 'tool_call',
          id: 'tool-call',
          turnId: 'turn-1',
          ts: 3,
          toolName: 'Bash',
          intent: 'Check deployment status',
          args: { password: 'raw-tool-secret' },
        },
        {
          type: 'tool_result',
          id: 'tool-result',
          turnId: 'turn-1',
          ts: 4,
          toolUseId: 'tool-call',
          isError: false,
          content: { password: 'raw-result-secret' } as never,
        },
      ],
    ],
  ]);
  const tool = buildReadHistoryTool(
    historyDeps([session('past', 'Past sk-ant-title-secret-12345 work', 1)], messages),
  );

  const result = await tool.impl(
    { session_id: 'past', message_id: 'tool-result', before: 0, after: 0 },
    context(),
  );
  const serialized = JSON.stringify(result);

  assert.match(serialized, /history_read/u);
  assert.match(serialized, /\[redacted\]/u);
  assert.match(serialized, /Check deployment status/u);
  assert.match(serialized, /"anchor_message_id":"tool-result"/u);
  assert.match(serialized, /"message_id":"assistant-thinking"/u);
  assert.match(serialized, /"match_kind":"assistant_message"/u);
  assert.doesNotMatch(
    serialized,
    /private chain of thought|raw-tool-secret|raw-result-secret|sk-ant-title-secret-12345/u,
  );
  assert.ok(Buffer.byteLength(serialized, 'utf8') < HISTORY_READ_MAX_BYTES + 2_000);
  assert.match(serialized, /"truncated":true/u);
});

test('ReadHistory can open the current session around a message anchor', async () => {
  const messages = new Map<string, StoredMessage[]>([
    [
      'current',
      [
        user('first question', 'turn-1'),
        assistant('first answer', 'turn-1'),
        user('second question', 'turn-2'),
        assistant('second answer', 'turn-2'),
        user('third question', 'turn-3'),
        assistant('third answer', 'turn-3'),
      ],
    ],
  ]);
  const tool = buildReadHistoryTool(historyDeps([session('current', 'Current', 3)], messages));

  const result = (await tool.impl(
    { session_id: 'current', message_id: 'assistant-turn-2', before: 1, after: 0 },
    context(),
  )) as Record<string, unknown>;

  assert.equal(result.kind, 'history_read');
  assert.equal(result.is_current_session, true);
  assert.equal(result.anchor_turn_id, 'turn-2');
  assert.equal(result.has_more_before, false);
  assert.equal(result.has_more_after, true);
  assert.deepEqual(
    (result.turns as Array<{ turn_id: string }>).map((turn) => turn.turn_id),
    ['turn-1', 'turn-2'],
  );
});

test('ReadHistory rejects mismatched or hidden message anchors', async () => {
  const messages = new Map<string, StoredMessage[]>([
    [
      'past',
      [
        user('visible', 'turn-1'),
        {
          type: 'system_note',
          id: 'hidden-note',
          ts: 2,
          kind: 'session_start',
          data: {},
        },
      ],
    ],
  ]);
  const tool = buildReadHistoryTool(historyDeps([session('past', 'Past', 1)], messages));

  assert.match(
    JSON.stringify(
      await tool.impl(
        { session_id: 'past', message_id: 'user-turn-1', turn_id: 'turn-other' },
        context(),
      ),
    ),
    /anchor_mismatch/u,
  );
  assert.match(
    JSON.stringify(await tool.impl({ session_id: 'past', message_id: 'hidden-note' }, context())),
    /message_not_found/u,
  );
});

test('history access fails closed before transcript reads in incognito mode', async () => {
  let listCalls = 0;
  let readCalls = 0;
  const deps = {
    listSessions: async () => {
      listCalls += 1;
      return [session('past', 'Past', 1)];
    },
    readMessages: async () => {
      readCalls += 1;
      return [user('secret', 'turn-1')];
    },
    getPrivacyContext: async () => ({ incognitoActive: true }),
  };

  const search = await buildSearchHistoryTool(deps).impl({ query: 'secret' }, context());
  const read = await buildReadHistoryTool(deps).impl({ session_id: 'past' }, context());

  assert.match(JSON.stringify(search), /incognito_active/u);
  assert.match(JSON.stringify(read), /incognito_active/u);
  assert.equal(listCalls, 0);
  assert.equal(readCalls, 0);
});

function historyDeps(sessions: SessionSummary[], messages: ReadonlyMap<string, StoredMessage[]>) {
  return {
    listSessions: async () => sessions,
    readMessages: async (sessionId: string) => messages.get(sessionId) ?? null,
    getPrivacyContext: async () => ({ incognitoActive: false }),
  };
}

function session(
  id: string,
  name: string,
  lastMessageAt: number,
  backend: SessionSummary['backend'] = 'ai-sdk',
): SessionSummary {
  return {
    id,
    name,
    isFlagged: false,
    isArchived: false,
    labels: [],
    hasUnread: false,
    lastMessageAt,
    status: 'active',
    backend,
    llmConnectionSlug: 'test',
    connectionLocked: true,
    model: 'test-model',
    permissionMode: 'ask',
  };
}

function user(text: string, turnId: string): StoredMessage {
  return { type: 'user', id: `user-${turnId}`, turnId, ts: 1, text };
}

function assistant(text: string, turnId: string): StoredMessage {
  return {
    type: 'assistant',
    id: `assistant-${turnId}`,
    turnId,
    ts: 2,
    text,
    modelId: 'test-model',
  };
}

function context(): MakaToolContext {
  return {
    sessionId: 'current',
    turnId: 'current-turn',
    cwd: '/tmp',
    toolCallId: 'tool-call',
    abortSignal: new AbortController().signal,
    emitOutput: () => {},
  };
}

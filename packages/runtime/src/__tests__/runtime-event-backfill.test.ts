import { describe, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentRunHeader, RuntimeEvent, StoredMessage } from '@maka/core';
import { createSqliteRuntimeStore } from '@maka/storage';
import { expect } from '../test-helpers.js';
import {
  RUNTIME_EVENT_BACKFILL_STATE_KEY,
  backfillRuntimeEventsFromStoredMessages,
} from '../runtime-event-backfill.js';

const run: AgentRunHeader = {
  runId: 'run-1',
  sessionId: 'session-1',
  turnId: 'turn-1',
  status: 'completed',
  backendKind: 'fake',
  llmConnectionSlug: 'fake',
  modelId: 'fake-model',
  cwd: '/tmp/cwd',
  permissionMode: 'ask',
  createdAt: 100,
  updatedAt: 180,
  completedAt: 180,
};

function nextIds(): () => string {
  let index = 0;
  return () => {
    index += 1;
    return `rt-backfill-${index}`;
  };
}

function recoveryMarker(event: RuntimeEvent): Record<string, unknown> | undefined {
  return event.actions?.stateDelta?.[RUNTIME_EVENT_BACKFILL_STATE_KEY] as
    | Record<string, unknown>
    | undefined;
}

describe('runtime event backfill', () => {
  test('persists legacy tool history through the canonical generic RuntimeEvent writer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-runtime-backfill-sqlite-'));
    const store = createSqliteRuntimeStore(join(root, 'runtime.sqlite'));
    try {
      const result = backfillRuntimeEventsFromStoredMessages({
        run,
        messages: [
          {
            type: 'tool_call',
            id: 'legacy-tool-call',
            turnId: 'turn-1',
            ts: 120,
            toolName: 'Read',
            activityKind: 'read',
            displayName: 'Read file',
            intent: 'inspect',
            args: { path: 'README.md' },
          },
          {
            type: 'tool_result',
            id: 'legacy-tool-result',
            turnId: 'turn-1',
            ts: 130,
            toolUseId: 'legacy-tool-call',
            isError: false,
            content: { kind: 'text', text: 'file body' },
            durationMs: 42,
          },
          {
            type: 'turn_state',
            id: 'legacy-state',
            turnId: 'turn-1',
            ts: 180,
            status: 'completed',
            partialOutputRetained: true,
          },
        ],
        newId: nextIds(),
        now: () => 999,
      });

      for (const event of result.events) {
        await store.appendRuntimeEvent(event.sessionId, event.runId, event);
      }

      const persisted = await store.readImmutableRuntimeEvents(run.sessionId, run.runId);
      expect(persisted.map((event) => event.content?.kind ?? event.status)).toEqual([
        'function_call',
        'function_response',
        'completed',
      ]);
      expect(persisted[0]?.refs).toEqual({
        storedMessageId: 'legacy-tool-call',
        toolCallId: 'legacy-tool-call',
      });
      expect(persisted[1]?.refs).toEqual({
        storedMessageId: 'legacy-tool-result',
        toolCallId: 'legacy-tool-call',
      });
      expect(persisted.some((event) => event.actions?.toolDispatch !== undefined)).toBe(false);
      expect(persisted.some((event) => event.refs?.operationId !== undefined)).toBe(false);
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('prefers the persisted Run invocation identity over a caller fallback', () => {
    const result = backfillRuntimeEventsFromStoredMessages({
      run: { ...run, invocationId: 'persisted-invocation' },
      invocationId: 'caller-fallback',
      messages: [
        {
          type: 'turn_state',
          id: 'legacy-state',
          turnId: 'turn-1',
          ts: 180,
          status: 'completed',
          partialOutputRetained: false,
        },
      ],
      newId: nextIds(),
      now: () => 999,
    });

    expect(result.events.map((event) => event.invocationId)).toEqual(['persisted-invocation']);
  });

  test('preserves provider-native identity in StoredMessage fallback backfill', () => {
    const providerOutput = [
      {
        type: 'web_search_result',
        url: 'https://maka.example/',
        title: 'Maka',
        pageAge: null,
        encryptedContent: 'encrypted-result',
      },
    ];
    const result = backfillRuntimeEventsFromStoredMessages({
      run,
      messages: [
        {
          type: 'tool_call',
          id: 'search-1',
          turnId: 'turn-1',
          ts: 120,
          toolName: 'WebSearch',
          args: { query: 'latest Maka' },
          providerExecuted: true,
        },
        {
          type: 'tool_result',
          id: 'search-result-1',
          turnId: 'turn-1',
          ts: 130,
          toolUseId: 'search-1',
          isError: false,
          content: { kind: 'web_search', provider: 'model', query: 'latest Maka', rows: [] },
          providerExecuted: true,
          providerOutput,
        },
      ],
      newId: nextIds(),
      now: () => 999,
    });

    expect(result.events[0]?.content).toMatchObject({
      kind: 'function_call',
      providerExecuted: true,
    });
    expect(result.events[1]?.content).toMatchObject({
      kind: 'function_response',
      providerExecuted: true,
      providerOutput,
    });
  });

  test('drops provider-native fallback history when opaque replay output is unavailable', () => {
    const result = backfillRuntimeEventsFromStoredMessages({
      run,
      messages: [
        {
          type: 'tool_call',
          id: 'search-legacy',
          turnId: 'turn-1',
          ts: 120,
          toolName: 'WebSearch',
          args: { query: 'latest Maka' },
          providerExecuted: true,
        },
        {
          type: 'tool_result',
          id: 'search-result-legacy',
          turnId: 'turn-1',
          ts: 130,
          toolUseId: 'search-legacy',
          isError: false,
          content: { kind: 'web_search', provider: 'model', query: 'latest Maka', rows: [] },
          providerExecuted: true,
        },
      ],
      newId: nextIds(),
      now: () => 999,
    });

    expect(result.events.map((event) => event.content?.kind ?? event.status)).toEqual([
      'completed',
    ]);
    expect(result.diagnostics).toEqual([
      {
        code: 'skipped_provider_native_replay_gap',
        message:
          'provider-native tool history requires the opaque provider output for lossless recovery',
        detail: { messageId: 'search-legacy', toolUseId: 'search-legacy' },
      },
    ]);
  });

  test('backfills a host-authored graph wake without attributing it to the user', () => {
    const result = backfillRuntimeEventsFromStoredMessages({
      run,
      messages: [
        {
          type: 'user',
          id: 'legacy-graph-wake',
          turnId: 'turn-1',
          ts: 101,
          text: 'graph checkpoint',
          origin: {
            kind: 'agent_graph',
            graphId: 'graph-1',
            wakeId: 'wake-1',
            attemptId: 'attempt-1',
          },
        },
      ],
      newId: nextIds(),
      now: () => 999,
    });

    expect(result.events[0]?.role).toBe('user');
    expect(result.events[0]?.author).toBe('host');
    expect(result.events[0]?.content).toMatchObject({
      kind: 'text',
      origin: {
        kind: 'agent_graph',
        graphId: 'graph-1',
        wakeId: 'wake-1',
        attemptId: 'attempt-1',
      },
    });
  });

  test('backfills nested CodeMode tool rows without making them model-visible', () => {
    const identity = {
      origin: 'code_mode' as const,
      modelVisibility: 'hidden' as const,
      parentToolCallId: 'exec-1',
      parentOperationId: 'exec-op-1',
    };
    const result = backfillRuntimeEventsFromStoredMessages({
      run,
      messages: [
        {
          type: 'tool_call',
          id: 'nested-1',
          turnId: 'turn-1',
          ts: 120,
          toolName: 'Read',
          args: {},
          ...identity,
        },
        {
          type: 'tool_result',
          id: 'nested-result-1',
          turnId: 'turn-1',
          ts: 130,
          toolUseId: 'nested-1',
          isError: false,
          content: { kind: 'text', text: 'ok' },
          ...identity,
        },
      ],
      newId: nextIds(),
      now: () => 999,
    });

    const toolEvents = result.events.filter(
      (event) =>
        event.content?.kind === 'function_call' || event.content?.kind === 'function_response',
    );
    expect(toolEvents).toHaveLength(2);
    for (const event of toolEvents) {
      expect(event).toMatchObject({ origin: 'code_mode', modelVisibility: 'hidden' });
      expect(event.refs).toMatchObject({
        parentToolCallId: 'exec-1',
        parentOperationId: 'exec-op-1',
      });
    }
  });

  test('backfills only low-risk RuntimeEvents from legacy StoredMessage rows', () => {
    const messages: StoredMessage[] = [
      {
        type: 'user',
        id: 'legacy-user',
        turnId: 'turn-1',
        ts: 101,
        text: 'hello',
        attachments: [
          {
            kind: 'other',
            name: 'note.txt',
            mimeType: 'text/plain',
            bytes: 12,
            ref: {
              kind: 'session_file',
              sessionId: 'session-1',
              relativePath: 'attachments/note.txt',
            },
          },
        ],
      },
      {
        type: 'assistant',
        id: 'legacy-assistant',
        turnId: 'turn-1',
        ts: 110,
        text: 'answer',
        modelId: 'fake-model',
        thinking: { text: 'reasoning', signature: 'sig-1' },
      },
      {
        type: 'tool_call',
        id: 'tool-1',
        turnId: 'turn-1',
        ts: 120,
        toolName: 'Read',
        activityKind: 'read',
        displayName: 'Read file',
        intent: 'inspect',
        args: { path: 'README.md' },
        stepId: 'step-1',
      },
      {
        type: 'tool_result',
        id: 'legacy-tool-result',
        turnId: 'turn-1',
        ts: 130,
        toolUseId: 'tool-1',
        isError: false,
        content: { kind: 'text', text: 'file body' },
        durationMs: 42,
      },
      {
        type: 'permission_decision',
        id: 'perm-1',
        turnId: 'turn-1',
        ts: 140,
        toolUseId: 'tool-1',
        toolName: 'Read',
        decision: 'allow',
        rememberForTurn: true,
      },
      {
        type: 'token_usage',
        id: 'usage-1',
        turnId: 'turn-1',
        ts: 150,
        input: 10,
        output: 5,
        total: 15,
      },
      {
        type: 'turn_state',
        id: 'legacy-state',
        turnId: 'turn-1',
        ts: 180,
        status: 'completed',
        partialOutputRetained: true,
      },
    ];

    const result = backfillRuntimeEventsFromStoredMessages({
      run,
      messages,
      newId: nextIds(),
      now: () => 999,
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.events.map((event) => event.id)).toEqual([
      'rt-backfill-1',
      'rt-backfill-2',
      'rt-backfill-3',
      'rt-backfill-4',
      'rt-backfill-5',
      'rt-backfill-6',
      'rt-backfill-7',
      'rt-backfill-8',
    ]);
    expect(result.events.map((event) => event.invocationId)).toEqual(
      Array(8).fill('backfill-run-1'),
    );
    expect(result.events.map((event) => event.partial)).toEqual(Array(8).fill(false));
    expect(result.events[0]?.content).toEqual({
      kind: 'text',
      text: 'hello',
      attachments: [
        {
          kind: 'other',
          name: 'note.txt',
          mimeType: 'text/plain',
          bytes: 12,
          ref: {
            kind: 'session_file',
            sessionId: 'session-1',
            relativePath: 'attachments/note.txt',
          },
        },
      ],
    });
    expect(result.events[1]?.content).toEqual({ kind: 'text', text: 'answer' });
    expect(result.events[2]?.content).toEqual({
      kind: 'thinking',
      text: 'reasoning',
      signature: 'sig-1',
    });
    expect(result.events[3]?.content).toEqual({
      kind: 'function_call',
      id: 'tool-1',
      name: 'Read',
      args: { path: 'README.md' },
    });
    expect(result.events[3]?.actions?.stateDelta?.displayName).toBe('Read file');
    expect(result.events[3]?.actions?.stateDelta?.activityKind).toBe('read');
    expect(result.events[3]?.actions?.stateDelta?.intent).toBe('inspect');
    expect(result.events[3]?.refs).toEqual({
      storedMessageId: 'tool-1',
      toolCallId: 'tool-1',
      stepId: 'step-1',
    });
    expect(result.events[4]?.content).toEqual({
      kind: 'function_response',
      id: 'tool-1',
      name: 'Read',
      result: { kind: 'text', text: 'file body' },
      isError: false,
    });
    expect(result.events[4]?.actions?.stateDelta?.durationMs).toBe(42);
    expect(result.events[5]?.actions?.permissionDecision).toEqual({
      requestId: 'perm-1',
      decision: 'allow',
      rememberForTurn: true,
    });
    expect(result.events[5]?.refs).toEqual({ storedMessageId: 'perm-1', toolCallId: 'tool-1' });
    expect(result.events[6]?.actions?.tokenUsage).toEqual({ input: 10, output: 5, total: 15 });
    expect(result.events[7]?.status).toBe('completed');
    expect(result.events[7]?.actions?.endInvocation).toBe(true);
    expect(result.events[7]?.refs).toEqual({ storedMessageId: 'legacy-state' });

    expect(recoveryMarker(result.events[3]!)).toBe(undefined);
    expect(recoveryMarker(result.events[4]!)).toBe(undefined);
    for (const index of [0, 1, 2, 5, 6, 7]) {
      expect(recoveryMarker(result.events[index]!)).toMatchObject({
        kind: 'runtime_event_backfill',
        source: 'legacy_stored_message',
        reason: 'missing_runtime_event_ledger',
        confidence: 'lossless',
        generatedAt: 999,
        version: 1,
      });
    }
  });

  test('skips high-risk legacy rows that cannot be reconstructed safely', () => {
    const messages: StoredMessage[] = [
      {
        type: 'tool_result',
        id: 'orphan-result',
        turnId: 'turn-1',
        ts: 120,
        toolUseId: 'missing-tool',
        isError: false,
        content: { kind: 'text', text: 'orphan' },
      },
      {
        type: 'permission_decision',
        id: 'orphan-permission',
        turnId: 'turn-1',
        ts: 130,
        toolUseId: 'missing-tool',
        toolName: 'Write',
        decision: 'deny',
      },
      {
        type: 'system_note',
        id: 'session-note',
        turnId: 'turn-1',
        ts: 140,
        kind: 'session_resume',
      },
      {
        type: 'turn_state',
        id: 'legacy-state',
        turnId: 'turn-1',
        ts: 180,
        status: 'completed',
        partialOutputRetained: false,
      },
    ];

    const result = backfillRuntimeEventsFromStoredMessages({
      run,
      messages,
      newId: nextIds(),
      now: () => 999,
    });

    expect(result.events.map((event) => event.status)).toEqual(['completed']);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'skipped_unmatched_tool_result',
      'skipped_unmatched_permission_decision',
      'skipped_high_risk_message',
    ]);
  });
});

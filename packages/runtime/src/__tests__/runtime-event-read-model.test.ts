import { describe, test } from 'node:test';
import type { AgentRunHeader } from '@maka/core/agent-run';
import type { CreateSessionInput, SessionListFilter } from '@maka/core/runtime-inputs';
import type { RuntimeEvent, RuntimeEventActions } from '@maka/core/runtime-event';
import type { SessionHeader, SessionSummary, StoredMessage, TurnRecord } from '@maka/core/session';
import { deriveTurnRecords } from '@maka/core/session';
import { expect } from '../test-helpers.js';
import {
  compareRuntimeReadModelMessages,
  isHardRuntimeEventReadModelDiagnostic,
  isUnclaimedRuntimeEventDiagnostic,
  projectRuntimeEventsToStoredMessages,
  projectRuntimeEventsToStoredMessagesWithArchiveStatuses,
} from '../runtime-event-read-model.js';
import { buildRuntimeEventModelReplayPlan } from '../model-history.js';
import { materializeSession } from '../materializer.js';
import { BackendRegistry, SessionManager, type SessionStore } from '../session-manager.js';

const ts = 1_800_000_000_000;
const sessionId = 'sess-1';
const runId = 'run-1';
const turnId = 'turn-1';
const invocationId = 'inv-1';
let eventSeq = 0;

const header: AgentRunHeader = {
  runId,
  sessionId,
  turnId,
  status: 'completed',
  backendKind: 'ai-sdk',
  llmConnectionSlug: 'anthropic',
  modelId: 'claude-sonnet-4-5',
  cwd: '/tmp/work',
  permissionMode: 'ask',
  createdAt: ts,
  updatedAt: ts + 20,
  completedAt: ts + 20,
  parentTurnId: 'parent-turn',
};

function ev(overrides: Partial<RuntimeEvent>): RuntimeEvent {
  eventSeq += 1;
  return {
    id: `event-${eventSeq}`,
    invocationId,
    runId,
    sessionId,
    turnId,
    ts,
    partial: false,
    role: 'system',
    author: 'system',
    ...overrides,
  };
}

function baseEvents(): RuntimeEvent[] {
  return [
    ev({
      id: 'evt-user',
      ts: ts + 1,
      role: 'user',
      author: 'user',
      content: { kind: 'text', text: 'read the file' },
      refs: { storedMessageId: 'legacy-user' },
    }),
    ev({
      id: 'evt-tool-call',
      ts: ts + 2,
      role: 'model',
      author: 'agent',
      content: {
        kind: 'function_call',
        id: 'tool-1',
        name: 'Read',
        args: { path: '/tmp/a.txt' },
      },
      actions: { stateDelta: { displayName: 'Read file', intent: 'inspect' } },
      refs: { toolCallId: 'tool-1' },
    }),
    ev({
      id: 'evt-permission-request',
      ts: ts + 3,
      role: 'system',
      author: 'system',
      actions: {
        permissionRequest: {
          kind: 'tool_permission',
          requestId: 'req-1',
          toolUseId: 'tool-1',
          toolName: 'Read',
          category: 'read',
          reason: 'custom',
          args: { path: '/tmp/a.txt' },
          rememberForTurnAllowed: true,
          hint: 'needs read access',
        },
      },
      refs: { toolCallId: 'tool-1' },
    }),
    ev({
      id: 'evt-permission-decision',
      ts: ts + 4,
      role: 'system',
      author: 'user',
      actions: {
        permissionDecision: {
          requestId: 'req-1',
          decision: 'allow',
          rememberForTurn: true,
        },
      },
      refs: { toolCallId: 'tool-1' },
    }),
    ev({
      id: 'evt-tool-result',
      ts: ts + 5,
      role: 'tool',
      author: 'tool',
      content: {
        kind: 'function_response',
        id: 'tool-1',
        name: 'Read',
        result: { kind: 'text', text: 'file contents' },
      },
      actions: { stateDelta: { durationMs: 42 } },
      refs: { toolCallId: 'tool-1', storedMessageId: 'legacy-result' },
    }),
    ev({
      id: 'evt-assistant',
      ts: ts + 6,
      role: 'model',
      author: 'agent',
      content: { kind: 'text', text: 'The file says: file contents' },
      refs: { storedMessageId: 'legacy-assistant' },
    }),
    ev({
      id: 'evt-token',
      ts: ts + 7,
      role: 'system',
      author: 'system',
      actions: {
        tokenUsage: {
          input: 100,
          output: 25,
          cacheRead: 10,
          costUsd: 0.002,
          systemPromptHash: 'sys-hash',
          runtimeSteps: 3,
          contextRemaining: 9000,
        },
      },
      refs: { providerRequestTraceId: 'provider-trace-1' },
    }),
    ev({
      id: 'evt-complete',
      ts: ts + 8,
      role: 'system',
      author: 'system',
      status: 'completed',
      actions: { endInvocation: true },
    }),
  ];
}

function equivalentLegacyMessages(): StoredMessage[] {
  return [
    {
      type: 'user',
      id: 'legacy-user',
      turnId,
      ts: ts + 1,
      text: 'read the file',
    },
    {
      type: 'tool_call',
      id: 'tool-1',
      turnId,
      ts: ts + 2,
      toolName: 'Read',
      displayName: 'Read file',
      intent: 'inspect',
      args: { path: '/tmp/a.txt' },
    },
    {
      type: 'permission_decision',
      id: 'req-1',
      turnId,
      ts: ts + 4,
      toolUseId: 'tool-1',
      toolName: 'Read',
      decision: 'allow',
      rememberForTurn: true,
      hint: 'needs read access',
    },
    {
      type: 'tool_result',
      id: 'legacy-result',
      turnId,
      ts: ts + 5,
      toolUseId: 'tool-1',
      isError: false,
      content: { kind: 'text', text: 'file contents' },
      durationMs: 42,
    },
    {
      type: 'assistant',
      id: 'legacy-assistant',
      turnId,
      ts: ts + 6,
      text: 'The file says: file contents',
      modelId: 'claude-sonnet-4-5',
    },
    {
      type: 'token_usage',
      id: 'evt-token',
      turnId,
      ts: ts + 7,
      input: 100,
      output: 25,
      cacheRead: 10,
      costUsd: 0.002,
      systemPromptHash: 'sys-hash',
      runtimeSteps: 3,
      contextRemaining: 9000,
      providerRequestTraceId: 'provider-trace-1',
    },
    {
      type: 'turn_state',
      id: 'evt-complete',
      turnId,
      ts: ts + 8,
      status: 'completed',
      parentTurnId: 'parent-turn',
      partialOutputRetained: true,
    },
  ];
}

describe('projectRuntimeEventsToStoredMessages', () => {
  test('projects user displayText from RuntimeEvent text content', () => {
    const typed = '/skill:alpha 帮我整理';
    const envelope = 'The user explicitly invoked…\n\n<user-message>\n帮我整理\n</user-message>';
    const out = projectRuntimeEventsToStoredMessages(
      [
        ev({
          id: 'evt-user-skill',
          ts: ts + 1,
          role: 'user',
          author: 'user',
          content: { kind: 'text', text: envelope, displayText: typed },
          refs: { storedMessageId: 'user-skill' },
        }),
      ],
      { runHeaders: [header] },
    );
    expect(out.messages).toEqual([
      {
        type: 'user',
        id: 'user-skill',
        turnId,
        ts: ts + 1,
        text: envelope,
        displayText: typed,
      },
    ]);
    const compare = compareRuntimeReadModelMessages(out.messages, [
      {
        type: 'user',
        id: 'user-skill',
        turnId,
        ts: ts + 1,
        text: envelope,
        displayText: typed,
      },
    ]);
    expect(compare.diagnostics).toEqual([]);
  });

  test('full RuntimeEvent turn projects legacy-compatible rows', () => {
    const out = projectRuntimeEventsToStoredMessages(baseEvents(), { runHeaders: [header] });

    expect(out.messages.map((message) => message.type)).toEqual([
      'user',
      'tool_call',
      'permission_decision',
      'tool_result',
      'assistant',
      'token_usage',
      'turn_state',
    ]);
    expect(out.messages[1]).toMatchObject({
      type: 'tool_call',
      id: 'tool-1',
      toolName: 'Read',
      displayName: 'Read file',
      intent: 'inspect',
    });
    expect(out.messages[2]).toMatchObject({
      type: 'permission_decision',
      id: 'req-1',
      toolUseId: 'tool-1',
      toolName: 'Read',
      decision: 'allow',
      hint: 'needs read access',
    });
    expect(out.messages[3]).toMatchObject({
      type: 'tool_result',
      id: 'legacy-result',
      toolUseId: 'tool-1',
      durationMs: 42,
    });
    expect(out.messages[4]).toMatchObject({
      type: 'assistant',
      modelId: 'claude-sonnet-4-5',
      text: 'The file says: file contents',
    });
    expect(out.messages[6]).toMatchObject({
      type: 'turn_state',
      status: 'completed',
      parentTurnId: 'parent-turn',
      partialOutputRetained: true,
    });
    expect(out.diagnostics).toEqual([]);
  });

  test('projects provider-native search through the canonical read model while replay keeps raw output', () => {
    const rawProviderOutput = [
      {
        type: 'web_search_result',
        url: 'https://maka.example/',
        title: 'Maka',
        pageAge: null,
        encryptedContent: 'encrypted-result',
      },
    ];
    const events = [
      ev({
        id: 'evt-native-text',
        ts: ts + 1,
        role: 'model',
        author: 'agent',
        content: {
          kind: 'text',
          text: 'Maka is current.',
          providerOptions: {
            openai: {
              itemId: 'message-1',
              annotations: [{ type: 'url_citation', url: 'https://maka.example/' }],
            },
          },
        },
        refs: { providerEventId: 'step-native' },
      }),
      ev({
        id: 'evt-native-call',
        ts: ts + 2,
        role: 'model',
        author: 'agent',
        content: {
          kind: 'function_call',
          id: 'search-1',
          name: 'WebSearch',
          args: { query: 'latest Maka' },
          providerOptions: { anthropic: { type: 'server_tool_use' } },
          providerExecuted: true,
        },
        refs: { toolCallId: 'search-1', stepId: 'step-native' },
      }),
      ev({
        id: 'evt-native-result',
        ts: ts + 3,
        role: 'tool',
        author: 'tool',
        content: {
          kind: 'function_response',
          id: 'search-1',
          name: 'WebSearch',
          result: {
            kind: 'web_search',
            provider: 'model',
            query: 'latest Maka',
            rows: [
              {
                title: 'Maka',
                url: 'https://maka.example/',
                snippet: '',
                source: 'maka.example',
              },
            ],
          },
          providerExecuted: true,
          providerOutput: rawProviderOutput,
        },
        refs: { toolCallId: 'search-1' },
      }),
    ];

    const projected = projectRuntimeEventsToStoredMessages(events, { runHeaders: [header] });
    expect(projected.diagnostics).toEqual([]);
    expect(projected.messages[0]).toMatchObject({
      type: 'assistant',
      providerOptions: {
        openai: {
          itemId: 'message-1',
          annotations: [{ type: 'url_citation', url: 'https://maka.example/' }],
        },
      },
    });
    expect(projected.messages[1]).toMatchObject({
      type: 'tool_call',
      providerOptions: { anthropic: { type: 'server_tool_use' } },
      providerExecuted: true,
    });
    expect(projected.messages[2]).toMatchObject({
      type: 'tool_result',
      providerExecuted: true,
      providerOutput: rawProviderOutput,
      content: {
        kind: 'web_search',
        provider: 'model',
        query: 'latest Maka',
        rows: [
          {
            title: 'Maka',
            url: 'https://maka.example/',
            snippet: '',
            source: 'maka.example',
          },
        ],
      },
    });

    const replay = buildRuntimeEventModelReplayPlan(events);
    expect(replay.diagnostics).toEqual([]);
    expect(
      replay.items.find((item) => item.kind === 'tool_result' && item.toolCallId === 'search-1'),
    ).toMatchObject({
      output: rawProviderOutput,
      providerExecuted: true,
    });
  });

  test('projects an AskUserQuestion round trip without a legacy row for the live request', () => {
    const out = projectRuntimeEventsToStoredMessages(
      [
        ev({
          id: 'evt-question-call',
          ts: ts + 1,
          role: 'model',
          author: 'agent',
          content: {
            kind: 'function_call',
            id: 'question-tool-1',
            name: 'AskUserQuestion',
            args: { questions: [{ question: 'Choose', options: [{ label: 'Extend' }] }] },
          },
          refs: { toolCallId: 'question-tool-1' },
        }),
        ev({
          id: 'evt-question-request',
          ts: ts + 2,
          actions: {
            userQuestionRequest: {
              requestId: 'question-1',
              toolUseId: 'question-tool-1',
              questions: [{ question: 'Choose', options: [{ label: 'Extend' }] }],
            },
          },
          refs: { toolCallId: 'question-tool-1' },
        }),
        ev({
          id: 'evt-question-result',
          ts: ts + 3,
          role: 'tool',
          author: 'tool',
          content: {
            kind: 'function_response',
            id: 'question-tool-1',
            name: 'AskUserQuestion',
            result: { kind: 'json', value: { answers: ['Extend'] } },
          },
          refs: { toolCallId: 'question-tool-1' },
        }),
        ev({
          id: 'evt-question-complete',
          ts: ts + 4,
          status: 'completed',
          actions: { endInvocation: true },
        }),
      ],
      { runHeaders: [header] },
    );

    expect(out.messages.map((message) => message.type)).toEqual([
      'tool_call',
      'tool_result',
      'turn_state',
    ]);
    expect(out.diagnostics).toEqual([]);
  });

  test('replays generic provider tool results without Maka result decoding', () => {
    const events = [
      ev({
        id: 'evt-generic-primitive-call',
        role: 'model',
        author: 'agent',
        content: {
          kind: 'function_call',
          id: 'generic-primitive-1',
          name: 'ProviderPrimitive',
          args: {},
        },
      }),
      ev({
        id: 'evt-generic-primitive-result',
        role: 'tool',
        author: 'tool',
        content: {
          kind: 'function_response',
          id: 'generic-primitive-1',
          name: 'ProviderPrimitive',
          result: 42 as never,
        },
      }),
      ev({
        id: 'evt-generic-json-call',
        role: 'model',
        author: 'agent',
        content: {
          kind: 'function_call',
          id: 'generic-json-1',
          name: 'ProviderJson',
          args: {},
        },
      }),
      ev({
        id: 'evt-generic-json-result',
        role: 'tool',
        author: 'tool',
        content: {
          kind: 'function_response',
          id: 'generic-json-1',
          name: 'ProviderJson',
          result: { providerPayload: true, values: [1, 2, 3] } as never,
        },
      }),
      ev({
        id: 'evt-generic-subagent-collision-call',
        role: 'model',
        author: 'agent',
        content: {
          kind: 'function_call',
          id: 'generic-subagent-collision-1',
          name: 'ProviderJson',
          args: {},
        },
      }),
      ev({
        id: 'evt-generic-subagent-collision-result',
        role: 'tool',
        author: 'tool',
        content: {
          kind: 'function_response',
          id: 'generic-subagent-collision-1',
          name: 'ProviderJson',
          result: {
            kind: 'subagent',
            status: 'waiting_permission',
            providerPayload: true,
          } as never,
        },
      }),
    ];

    const replay = buildRuntimeEventModelReplayPlan(events);

    expect(replay.items.map((item) => item.kind)).toEqual([
      'tool_call',
      'tool_result',
      'tool_call',
      'tool_result',
      'tool_call',
      'tool_result',
    ]);
    expect(
      replay.items.filter((item) => item.kind === 'tool_result').map((item) => item.output),
    ).toEqual([
      42,
      { providerPayload: true, values: [1, 2, 3] },
      {
        kind: 'subagent',
        status: 'waiting_permission',
        providerPayload: true,
      },
    ]);
    expect(replay.diagnostics).toEqual([]);
  });

  test('restores a settled Agent Swarm function response', () => {
    const result = {
      kind: 'agent_swarm' as const,
      status: 'completed' as const,
      items: [
        {
          itemId: 'contract',
          index: 0,
          profile: 'local_read',
          started: true,
          agentId: 'local-read',
          agentName: 'Local Read',
          turnId: 'child-turn',
          runId: 'child-run',
          status: 'completed' as const,
          summary: 'Verified the contract.',
          artifactIds: [],
          startedAt: ts + 1,
          completedAt: ts + 2,
          durationMs: 1,
        },
      ],
      startedAt: ts,
      completedAt: ts + 2,
      durationMs: 2,
    };
    const out = projectRuntimeEventsToStoredMessages(
      [
        ev({
          id: 'evt-agent-swarm-result',
          role: 'tool',
          author: 'tool',
          content: {
            kind: 'function_response',
            id: 'tool-agent-swarm',
            name: 'agent_swarm',
            result,
          },
          refs: { toolCallId: 'tool-agent-swarm' },
        }),
      ],
      { runHeaders: [header] },
    );

    const projected = out.messages.find((message) => message.type === 'tool_result');
    expect(projected?.type === 'tool_result' ? projected.content : undefined).toEqual(result);
    expect(out.diagnostics).toEqual([]);
  });

  test('projects first-observed step content order for stable live handoff', () => {
    const out = projectRuntimeEventsToStoredMessages(
      [
        ev({
          ts: ts + 1,
          role: 'model',
          author: 'agent',
          content: { kind: 'function_call', id: 'tool-1', name: 'Read', args: {} },
          refs: { toolCallId: 'tool-1', stepId: 'message-1' },
        }),
        ev({
          ts: ts + 2,
          role: 'model',
          author: 'agent',
          content: { kind: 'thinking', text: 'late reasoning' },
          refs: { providerEventId: 'message-1' },
        }),
        ev({
          ts: ts + 3,
          role: 'model',
          author: 'agent',
          content: { kind: 'text', text: 'answer' },
          refs: { providerEventId: 'message-1' },
        }),
      ],
      { runHeaders: [header] },
    );

    const assistant = out.messages.find((message) => message.type === 'assistant');
    expect((assistant as unknown as { contentOrder?: string[] } | undefined)?.contentOrder).toEqual(
      ['tools', 'thinking', 'text'],
    );
  });

  test('archived tool-result placeholders project to diagnostic tool-result rows', () => {
    const events = baseEvents();
    const toolResult = events.find((event) => event.id === 'evt-tool-result');
    if (toolResult?.content?.kind !== 'function_response')
      throw new Error('fixture missing tool result');
    toolResult.content.result = {
      kind: 'maka.archived_tool_result',
      rewriteVersion: 1,
      artifactId: 'artifact-tool-result',
      runtimeEventId: 'evt-tool-result',
      toolCallId: 'tool-1',
      toolName: 'Read',
      bodySha256: 'a'.repeat(64),
      originalEstimatedTokens: 200,
      originalBytes: 800,
      reason: 'stale_tool_result_pruned_before_compact',
    };

    const out = projectRuntimeEventsToStoredMessages(events, { runHeaders: [header] });
    const projected = out.messages.find((message) => message.type === 'tool_result');

    expect(projected).toMatchObject({
      type: 'tool_result',
      toolUseId: 'tool-1',
      content: {
        kind: 'archived_tool_result',
        status: 'not_loaded',
        artifactId: 'artifact-tool-result',
        bodySha256: 'a'.repeat(64),
        runtimeEventId: 'evt-tool-result',
        toolCallId: 'tool-1',
        toolName: 'Read',
        originalEstimatedTokens: 200,
        originalBytes: 800,
        rewriteVersion: 1,
        reason: 'stale_tool_result_pruned_before_compact',
      },
    });
    expect(out.diagnostics.map((diag) => diag.code)).toEqual(['archived_tool_result_placeholder']);
  });

  test('archive status wrapper can project missing and corrupt rows without changing sync defaults', () => {
    const events = baseEvents();
    const toolResult = events.find((event) => event.id === 'evt-tool-result');
    if (toolResult?.content?.kind !== 'function_response')
      throw new Error('fixture missing tool result');
    toolResult.content.result = {
      kind: 'maka.archived_tool_result',
      rewriteVersion: 1,
      artifactId: 'artifact-tool-result',
      runtimeEventId: 'evt-tool-result',
      toolCallId: 'tool-1',
      toolName: 'Read',
      bodySha256: 'a'.repeat(64),
      originalEstimatedTokens: 200,
      originalBytes: 800,
      reason: 'stale_tool_result_pruned_before_compact',
    };

    const defaultOut = projectRuntimeEventsToStoredMessages(events, { runHeaders: [header] });
    const defaultProjected = defaultOut.messages.find((message) => message.type === 'tool_result');
    expect(defaultProjected).toMatchObject({ type: 'tool_result' });
    expect(archivedStatus(defaultProjected)).toBe('not_loaded');

    const missingOut = projectRuntimeEventsToStoredMessagesWithArchiveStatuses(events, {
      runHeaders: [header],
      archiveStatuses: { 'evt-tool-result': 'missing' },
    });
    const missingProjected = missingOut.messages.find((message) => message.type === 'tool_result');
    expect(missingProjected).toMatchObject({ type: 'tool_result' });
    expect(archivedStatus(missingProjected)).toBe('missing');

    const corruptOut = projectRuntimeEventsToStoredMessagesWithArchiveStatuses(events, {
      runHeaders: [header],
      archiveStatuses: [{ runtimeEventId: 'evt-tool-result', status: 'corrupt' }],
    });
    const corruptProjected = corruptOut.messages.find((message) => message.type === 'tool_result');
    expect(corruptProjected).toMatchObject({ type: 'tool_result' });
    expect(archivedStatus(corruptProjected)).toBe('corrupt');
  });

  test('partial RuntimeEvents are excluded', () => {
    const out = projectRuntimeEventsToStoredMessages(
      [
        ev({
          id: 'evt-partial',
          partial: true,
          role: 'model',
          author: 'agent',
          content: { kind: 'text', text: 'streaming' },
        }),
        ev({
          id: 'evt-final',
          role: 'model',
          author: 'agent',
          content: { kind: 'text', text: 'final' },
        }),
      ],
      { runHeaders: [header] },
    );

    expect(out.messages).toHaveLength(1);
    expect(out.messages[0]).toMatchObject({ type: 'assistant', text: 'final' });
    expect(out.diagnostics.map((diag) => diag.code)).toEqual(['partial_skipped']);
  });

  test('tool dispatch recovery facts are accepted without creating legacy message rows', () => {
    const out = projectRuntimeEventsToStoredMessages(
      [
        ev({
          id: 'toolop-1-dispatch',
          role: 'system',
          author: 'system',
          actions: {
            toolDispatch: {
              protocol: 't1_after_preflight_v1',
              operationId: 'toolop-1',
              providerToolCallId: 'tool-1',
              toolName: 'Bash',
              canonicalArgsHash: 'sha256:args',
              recoveryMode: 'reconcile',
            },
          },
          refs: { toolCallId: 'tool-1', operationId: 'toolop-1' },
        }),
      ],
      { runHeaders: [header] },
    );

    expect(out.messages).toEqual([]);
    expect(out.diagnostics).toEqual([]);
  });

  test('question answer acknowledgements remain non-visible audit facts', () => {
    const out = projectRuntimeEventsToStoredMessages(
      [
        ev({
          id: 'question-1-answered',
          role: 'system',
          author: 'user',
          actions: { userQuestionAnswerAccepted: { requestId: 'question-1' } },
          refs: { toolCallId: 'tool-1' },
        }),
      ],
      { runHeaders: [header] },
    );

    expect(out.messages).toEqual([]);
    expect(out.diagnostics).toEqual([]);
  });

  test('terminal recovery bundle facts are accepted without creating legacy message rows', () => {
    const out = projectRuntimeEventsToStoredMessages(
      [
        ev({
          id: 'toolop-1-reconcile',
          role: 'system',
          author: 'system',
          actions: {
            toolRecovery: {
              kind: 'maka.tool.reconcile_result',
              version: 1,
              payload: {
                protocol: 'tool_reconcile_v1',
                operationId: 'toolop-1',
                observation: 'unreadable',
                observationSchema: 'state_identity_v1',
                observationDigest:
                  'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              },
            },
          },
          refs: { toolCallId: 'tool-1', operationId: 'toolop-1' },
        }),
        ev({
          id: 'toolop-1-decision',
          role: 'system',
          author: 'system',
          actions: {
            toolRecovery: {
              kind: 'maka.tool.recovery_decision',
              version: 1,
              payload: {
                protocol: 'tool_recovery_v1',
                operationId: 'toolop-1',
                disposition: 'parked',
                reasonCode: 'reconcile_unreadable',
                evidenceEventIds: ['call-1', 'dispatch-1', 'toolop-1-reconcile'],
              },
            },
          },
          refs: { toolCallId: 'tool-1', operationId: 'toolop-1' },
        }),
      ],
      { runHeaders: [header] },
    );

    expect(out.messages).toEqual([]);
    expect(out.diagnostics).toEqual([]);
  });

  test('continuation-start recovery facts are accepted without creating legacy message rows', () => {
    const out = projectRuntimeEventsToStoredMessages(
      [
        ev({
          id: 'continuation-start',
          role: 'system',
          author: 'system',
          actions: {
            continuationStart: {
              protocol: 'continuation_start_v2',
              provenance: 'runtime_admission',
              claimId: 'claim-1',
              boundaryDigest:
                'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              immediateSource: {
                sessionId: 'session-1',
                invocationId: 'source-invocation',
                runId: 'source-run',
                turnId: 'source-turn',
                highWater: 2,
                prefixDigest:
                  'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
              },
              replayManifestDigest:
                'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              providerProjectionVersion: 1,
              providerReplayDigest:
                'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
            },
          },
        }),
      ],
      { runHeaders: [header] },
    );

    expect(out.messages).toEqual([]);
    expect(out.diagnostics).toEqual([]);
  });

  test('sandbox boundary request and decision facts are accepted without creating legacy message rows', () => {
    const out = projectRuntimeEventsToStoredMessages(
      [
        ev({
          id: 'sandbox-boundary-request',
          ts: ts + 1,
          role: 'system',
          author: 'system',
          actions: {
            stateDelta: {
              sandboxBoundaryRequest: {
                requestId: 'boundary-1',
                toolUseId: 'tool-1',
                justification: 'read a file outside the workspace',
                expansion: {
                  filesystem: {
                    entries: [{ path: '/tmp/outside.txt', access: 'read', scope: 'exact' }],
                  },
                },
              },
            },
          },
          refs: { toolCallId: 'tool-1' },
        }),
        ev({
          id: 'sandbox-boundary-decision',
          ts: ts + 2,
          role: 'system',
          author: 'user',
          actions: {
            stateDelta: {
              sandboxBoundaryDecision: {
                requestId: 'boundary-1',
                decision: 'allow',
                status: 'approved',
                revision: 2,
              },
            },
          },
          refs: { toolCallId: 'tool-1' },
        }),
      ],
      { runHeaders: [header] },
    );

    expect(out.messages).toEqual([]);
    expect(out.diagnostics).toEqual([]);
  });

  // Claiming the key alone would let any shape ride in under a control-fact
  // name. Only what AiSdkFlow actually emits is a canonical fact: every field,
  // the system/user identity, and the tool-call reference.
  const wellFormedBoundaryRequest = () =>
    ev({
      id: 'sandbox-boundary-request-case',
      ts: ts + 1,
      role: 'system',
      author: 'system',
      actions: {
        stateDelta: {
          sandboxBoundaryRequest: {
            requestId: 'boundary-1',
            toolUseId: 'tool-1',
            justification: 'read a file outside the workspace',
            expansion: {
              filesystem: {
                entries: [{ path: '/tmp/outside.txt', access: 'read', scope: 'exact' }],
              },
            },
          },
        },
      },
      refs: { toolCallId: 'tool-1' },
    });

  const wellFormedBoundaryDecision = () =>
    ev({
      id: 'sandbox-boundary-decision-case',
      ts: ts + 2,
      role: 'system',
      author: 'user',
      actions: {
        stateDelta: {
          sandboxBoundaryDecision: {
            requestId: 'boundary-1',
            decision: 'allow',
            status: 'approved',
            revision: 2,
          },
        },
      },
      refs: { toolCallId: 'tool-1' },
    });

  function corruptedBoundaryEvent(
    base: RuntimeEvent,
    key: 'sandboxBoundaryRequest' | 'sandboxBoundaryDecision',
    mutate: (payload: Record<string, unknown>, event: RuntimeEvent) => RuntimeEvent | void,
  ): RuntimeEvent {
    const clone = structuredClone(base) as RuntimeEvent;
    const payload = clone.actions?.stateDelta?.[key] as Record<string, unknown>;
    return mutate(payload, clone) ?? clone;
  }

  const malformedBoundaryCases: Array<[string, () => RuntimeEvent]> = [
    [
      'request without a justification',
      () =>
        corruptedBoundaryEvent(wellFormedBoundaryRequest(), 'sandboxBoundaryRequest', (payload) => {
          delete payload.justification;
        }),
    ],
    [
      'request with an unusable expansion',
      () =>
        corruptedBoundaryEvent(wellFormedBoundaryRequest(), 'sandboxBoundaryRequest', (payload) => {
          payload.expansion = {};
        }),
    ],
    [
      'request that lost its tool-call reference',
      () =>
        corruptedBoundaryEvent(
          wellFormedBoundaryRequest(),
          'sandboxBoundaryRequest',
          (_payload, event) => ({ ...event, refs: undefined }),
        ),
    ],
    [
      'request attributed to someone other than the system',
      () =>
        corruptedBoundaryEvent(
          wellFormedBoundaryRequest(),
          'sandboxBoundaryRequest',
          (_payload, event) => ({ ...event, role: 'user', author: 'tool' }),
        ),
    ],
    [
      'decision without a status',
      () =>
        corruptedBoundaryEvent(
          wellFormedBoundaryDecision(),
          'sandboxBoundaryDecision',
          (payload) => {
            delete payload.status;
          },
        ),
    ],
    [
      'decision with a status the boundary never settles to',
      () =>
        corruptedBoundaryEvent(
          wellFormedBoundaryDecision(),
          'sandboxBoundaryDecision',
          (payload) => {
            payload.status = 'pending';
          },
        ),
    ],
    [
      'decision without a revision',
      () =>
        corruptedBoundaryEvent(
          wellFormedBoundaryDecision(),
          'sandboxBoundaryDecision',
          (payload) => {
            delete payload.revision;
          },
        ),
    ],
    [
      'decision attributed to the agent instead of the user',
      () =>
        corruptedBoundaryEvent(
          wellFormedBoundaryDecision(),
          'sandboxBoundaryDecision',
          (_payload, event) => ({ ...event, author: 'agent' }),
        ),
    ],
  ];

  for (const [name, makeEvent] of malformedBoundaryCases) {
    // The claim stays exact: a malformed shape is never admitted as a canonical
    // boundary fact. Its severity is a separate question, and a control fact
    // owns no chat row, so a broken one costs a reader nothing the session view
    // would otherwise show.
    test(`a sandbox boundary ${name} stays unclaimed`, () => {
      const out = projectRuntimeEventsToStoredMessages([makeEvent()], { runHeaders: [header] });

      expect(out.messages).toEqual([]);
      expect(out.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
        'unclaimed_control_fact',
      ]);
    });
  }

  test('model thinking attaches to the assistant text row that shares its step message id', () => {
    // Real emission and backfill give a step's thinking and text the same message
    // id (providerEventId / storedMessageId), so the projection pairs by id.
    const out = projectRuntimeEventsToStoredMessages(
      [
        ev({
          id: 'evt-thinking',
          ts: ts + 5,
          role: 'model',
          author: 'agent',
          content: {
            kind: 'thinking',
            text: 'private reasoning',
            signature: 'sig-1',
            providerOptions: { maka: { kimiReasoningField: 'reasoning' } },
          },
          refs: { storedMessageId: 'legacy-assistant' },
        }),
        ev({
          id: 'evt-assistant',
          ts: ts + 6,
          role: 'model',
          author: 'agent',
          content: { kind: 'text', text: 'visible answer' },
          refs: { storedMessageId: 'legacy-assistant' },
        }),
      ],
      { runHeaders: [header] },
    );
    const legacy: StoredMessage[] = [
      {
        type: 'assistant',
        id: 'legacy-assistant',
        turnId,
        ts: ts + 6,
        text: 'visible answer',
        modelId: 'claude-sonnet-4-5',
        thinking: {
          text: 'private reasoning',
          signature: 'sig-1',
          providerOptions: { maka: { kimiReasoningField: 'reasoning' } },
        },
      },
    ];

    expect(out.messages).toEqual(legacy);
    expect(out.diagnostics).toEqual([]);
    expect(compareRuntimeReadModelMessages(out.messages, legacy).compatible).toBe(true);
  });

  test('per-step thinking pairs each step assistant row by its own message id', () => {
    // Two steps in one turn, each with its own signed thinking. The ledger order
    // per step is thinking → text (finish-step flush), and each step's thinking
    // carries its step message id, so it must attach to its own assistant row —
    // not the last row of the turn.
    const out = projectRuntimeEventsToStoredMessages(
      [
        ev({
          id: 'evt-think-1',
          ts: ts + 1,
          role: 'model',
          author: 'agent',
          content: { kind: 'thinking', text: 'reasoning one', signature: 'sig-1' },
          refs: { providerEventId: 'step-1' },
        }),
        ev({
          id: 'evt-text-1',
          ts: ts + 2,
          role: 'model',
          author: 'agent',
          content: { kind: 'text', text: 'answer one' },
          refs: { providerEventId: 'step-1' },
        }),
        ev({
          id: 'evt-think-2',
          ts: ts + 3,
          role: 'model',
          author: 'agent',
          content: { kind: 'thinking', text: 'reasoning two', signature: 'sig-2' },
          refs: { providerEventId: 'step-2' },
        }),
        ev({
          id: 'evt-text-2',
          ts: ts + 4,
          role: 'model',
          author: 'agent',
          content: { kind: 'text', text: 'answer two' },
          refs: { providerEventId: 'step-2' },
        }),
      ],
      { runHeaders: [header] },
    );

    const assistants = out.messages.filter((message) => message.type === 'assistant');
    expect(assistants).toEqual([
      {
        type: 'assistant',
        id: 'step-1',
        turnId,
        ts: ts + 2,
        text: 'answer one',
        modelId: 'claude-sonnet-4-5',
        thinking: { text: 'reasoning one', signature: 'sig-1' },
      },
      {
        type: 'assistant',
        id: 'step-2',
        turnId,
        ts: ts + 4,
        text: 'answer two',
        modelId: 'claude-sonnet-4-5',
        thinking: { text: 'reasoning two', signature: 'sig-2' },
      },
    ]);
    expect(out.diagnostics).toEqual([]);
  });

  test('unsupported and incomplete events are diagnostic-only', () => {
    const out = projectRuntimeEventsToStoredMessages(
      [
        ev({
          id: 'evt-thinking',
          role: 'model',
          author: 'agent',
          content: { kind: 'thinking', text: 'private reasoning' },
        }),
        ev({
          id: 'evt-permission-orphan',
          actions: {
            permissionDecision: {
              requestId: 'missing-request',
              decision: 'deny',
            },
          },
        }),
        ev({
          id: 'evt-invalid-result',
          role: 'tool',
          author: 'tool',
          content: {
            kind: 'function_response',
            id: 'tool-x',
            name: 'Read',
            result: 'plain string is not ToolResultContent',
          },
        }),
      ],
      { runHeaders: [header] },
    );

    expect(out.messages).toEqual([]);
    // The orphaned permission decision carries no content, so its catch-all is
    // the soft code — but the projector that tried to build its row and failed
    // still reports `incomplete_event`, which stays hard. Downgrading the
    // catch-all never downgrades a projector that attempted a message.
    expect(out.diagnostics.map((diag) => diag.code)).toEqual([
      'incomplete_event',
      'unclaimed_control_fact',
      'incomplete_event',
      'unsupported_event',
      'unsupported_event',
    ]);
  });

  // Where the projection draws the line between a view it can still serve and
  // one it must refuse: an unclaimed event that carries no content owns no chat
  // row, so nothing a reader would have seen is missing.
  test('an unclaimed control-only event is soft and leaves every message intact', () => {
    const out = projectRuntimeEventsToStoredMessages(
      [
        ev({ id: 'evt-user', role: 'user', author: 'user', content: { kind: 'text', text: 'hi' } }),
        ev({
          id: 'evt-control',
          actions: { stateDelta: { somethingTheProjectionWasNeverTaught: true } },
        }),
        ev({
          id: 'evt-assistant',
          role: 'model',
          author: 'agent',
          content: { kind: 'text', text: 'hello' },
        }),
      ],
      { runHeaders: [header] },
    );

    expect(out.messages.map((message) => message.id)).toEqual(['evt-user', 'evt-assistant']);
    expect(out.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'unclaimed_control_fact',
    ]);
    expect(out.diagnostics.map((diagnostic) => diagnostic.eventId)).toEqual(['evt-control']);
    expect(out.diagnostics.some(isHardRuntimeEventReadModelDiagnostic)).toBe(false);
  });

  test('an unclaimed event that carries content stays hard', () => {
    const out = projectRuntimeEventsToStoredMessages(
      [
        ev({
          id: 'evt-future-content',
          role: 'model',
          author: 'agent',
          content: { kind: 'not_yet_projected', text: 'a reader would have seen this' } as never,
        }),
      ],
      { runHeaders: [header] },
    );

    expect(out.messages).toEqual([]);
    expect(out.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['unsupported_event']);
    expect(out.diagnostics.every(isHardRuntimeEventReadModelDiagnostic)).toBe(true);
  });

  test('failed terminal RuntimeEvent maps to failed turn state when run header carries failure class', () => {
    const out = projectRuntimeEventsToStoredMessages(
      [
        ev({
          id: 'evt-failed',
          ts: ts + 9,
          status: 'failed',
          actions: { endInvocation: true },
        }),
      ],
      {
        runHeaders: [{ ...header, status: 'failed', failureClass: 'tool_failed' }],
      },
    );

    expect(out.messages).toEqual([
      {
        type: 'turn_state',
        id: 'evt-failed',
        turnId,
        ts: ts + 9,
        status: 'failed',
        parentTurnId: 'parent-turn',
        errorClass: 'tool_failed',
        partialOutputRetained: false,
      },
    ]);
    expect(out.diagnostics).toEqual([]);
  });

  test('tool step cap terminal fact projects a persistent system notice', () => {
    const out = projectRuntimeEventsToStoredMessages(
      [
        ev({
          id: 'evt-step-limit',
          ts: ts + 9,
          status: 'failed',
          actions: {
            endInvocation: true,
            stateDelta: { stopReason: 'step_limit', failureClass: 'tool_step_cap_reached' },
          },
        }),
      ],
      {
        runHeaders: [{ ...header, status: 'failed', failureClass: 'tool_step_cap_reached' }],
      },
    );

    expect(out.messages.find((message) => message.type === 'system_note')).toEqual({
      type: 'system_note',
      id: 'evt-step-limit:step-limit-notice',
      turnId,
      ts: ts + 9,
      kind: 'step_limit',
    });
  });

  test('aborted terminal RuntimeEvent preserves abort source from runtime state', () => {
    const out = projectRuntimeEventsToStoredMessages(
      [
        ev({
          id: 'evt-aborted',
          ts: ts + 9,
          status: 'aborted',
          actions: { endInvocation: true, stateDelta: { abortSource: 'renderer.stop_button' } },
        }),
      ],
      {
        runHeaders: [{ ...header, status: 'cancelled' }],
      },
    );

    expect(out.messages).toEqual([
      {
        type: 'turn_state',
        id: 'evt-aborted',
        turnId,
        ts: ts + 9,
        status: 'aborted',
        parentTurnId: 'parent-turn',
        abortedAt: ts + 9,
        abortSource: 'renderer.stop_button',
        partialOutputRetained: false,
      },
    ]);
    expect(out.diagnostics).toEqual([]);
  });

  test('aborted terminal RuntimeEvent keeps an explicit diagnostic when abort source is unavailable', () => {
    const out = projectRuntimeEventsToStoredMessages(
      [
        ev({
          id: 'evt-aborted',
          ts: ts + 9,
          status: 'aborted',
          actions: { endInvocation: true },
        }),
      ],
      {
        runHeaders: [{ ...header, status: 'cancelled' }],
      },
    );

    expect(out.messages[0]).toMatchObject({
      type: 'turn_state',
      status: 'aborted',
      abortedAt: ts + 9,
    });
    expect(out.diagnostics.map((diag) => diag.code)).toEqual(['incomplete_event']);
  });

  test('projects tool_call stepId from refs so the UI timeline keeps step pairing', () => {
    const stepCall = (id: string, stepId?: string) =>
      ev({
        id: `evt-${id}`,
        role: 'model' as const,
        author: 'agent' as const,
        content: {
          kind: 'function_call' as const,
          id,
          name: 'Read',
          args: { path: '/tmp/a.txt' },
        },
        refs: { toolCallId: id, ...(stepId ? { stepId } : {}) },
      });

    const withStep = projectRuntimeEventsToStoredMessages([stepCall('tool-step', 'step-1')], {
      runHeaders: [header],
    });
    expect(withStep.messages[0]).toMatchObject({
      type: 'tool_call',
      id: 'tool-step',
      stepId: 'step-1',
    });

    // Legacy events without refs.stepId must not grow a stepId key: the UI
    // uses its absence to pick the backward-compatible tools-first ordering.
    const withoutStep = projectRuntimeEventsToStoredMessages([stepCall('tool-legacy')], {
      runHeaders: [header],
    });
    const legacyCall = withoutStep.messages[0];
    expect(legacyCall).toMatchObject({ type: 'tool_call', id: 'tool-legacy' });
    expect(legacyCall && 'stepId' in legacyCall).toBe(false);
  });

  test('retains nested CodeMode identity on tool rows used by the UI read model', () => {
    const identity = {
      origin: 'code_mode' as const,
      modelVisibility: 'hidden' as const,
      refs: {
        toolCallId: 'nested-1',
        parentToolCallId: 'exec-1',
        parentOperationId: 'exec-op-1',
      },
    };
    const out = projectRuntimeEventsToStoredMessages(
      [
        ev({
          ...identity,
          role: 'model',
          author: 'agent',
          content: { kind: 'function_call', id: 'nested-1', name: 'Read', args: {} },
        }),
        ev({
          ...identity,
          role: 'tool',
          author: 'tool',
          content: {
            kind: 'function_response',
            id: 'nested-1',
            name: 'Read',
            result: { kind: 'text', text: 'ok' },
          },
        }),
      ],
      { runHeaders: [header] },
    );

    expect(out.messages).toHaveLength(2);
    for (const message of out.messages) {
      expect(message).toMatchObject({
        origin: 'code_mode',
        modelVisibility: 'hidden',
        parentToolCallId: 'exec-1',
        parentOperationId: 'exec-op-1',
      });
    }
  });

  test('projects tool_call activityKind from runtime state for replay', () => {
    const out = projectRuntimeEventsToStoredMessages(
      [
        ev({
          id: 'evt-tool-kind',
          role: 'model',
          author: 'agent',
          content: {
            kind: 'function_call',
            id: 'tool-kind',
            name: 'CustomCommand',
            args: {},
          },
          actions: { stateDelta: { activityKind: 'command' } },
          refs: { toolCallId: 'tool-kind' },
        }),
      ],
      { runHeaders: [header] },
    );

    expect(out.messages[0]).toMatchObject({
      type: 'tool_call',
      id: 'tool-kind',
      activityKind: 'command',
    });
  });
});

/**
 * One reachable event per `RuntimeEventActions` field, each entry typed to its
 * own key so it cannot drift onto another field or be filled with a placeholder.
 *
 * This is the premise the read model's soft path rests on. An unclaimed
 * content-free event degrades the view instead of withholding it, which is only
 * safe while every action a reader can meet is claimed — several of them
 * (`permissionDecision`, `tokenUsage`, the terminal fact) do produce rows, and
 * `runtime-event-backfill.ts` already writes a content-free event that becomes a
 * visible `permission_decision`. The SessionEvent contract in ai-sdk-flow.test.ts
 * only covers events built by `mapSessionEventToRuntimeEvent`; tool-runtime,
 * terminal-run-commit and the backfill write RuntimeEvents directly. Keying this
 * table on the action surface itself covers those paths too.
 */
type ActionCoverageSamples = {
  [K in keyof Required<RuntimeEventActions>]: {
    /** The action value under test, typed to its own key. */
    action: Required<RuntimeEventActions>[K];
    /** The rest of the event, as the field's real emitter writes it. */
    event?: Partial<RuntimeEvent>;
  };
};

const ACTION_COVERAGE_SAMPLES: ActionCoverageSamples = {
  // `stateDelta` is an open record, so only named shapes are claimed and this
  // entry covers the field, not its contents. A new key inside a state delta is
  // out of reach of any contract keyed on the action surface.
  stateDelta: { action: { continuationStart: true } },
  continuationStart: {
    action: {
      protocol: 'continuation_start_v2',
      provenance: 'runtime_admission',
      claimId: 'coverage-claim',
      boundaryDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      immediateSource: {
        sessionId: 'coverage-session',
        invocationId: 'coverage-invocation',
        runId: 'coverage-run',
        turnId: 'coverage-turn',
        highWater: 1,
        prefixDigest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      },
      replayManifestDigest:
        'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      providerProjectionVersion: 1,
      providerReplayDigest:
        'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
    },
  },
  artifactDelta: { action: { 'artifact-1': 42 } },
  permissionRequest: {
    action: {
      kind: 'tool_permission',
      requestId: 'coverage-request',
      toolUseId: 'coverage-tool',
      toolName: 'Read',
      category: 'read',
      reason: 'custom',
      args: { path: '/tmp/a.txt' },
      rememberForTurnAllowed: true,
    },
    event: { refs: { toolCallId: 'coverage-tool' } },
  },
  permissionDecision: {
    action: { requestId: 'coverage-request', decision: 'allow', toolName: 'Read' },
    event: { refs: { toolCallId: 'coverage-tool' } },
  },
  // The canonical outcome lives in InteractionStore, so a standalone acceptance
  // reports an `incomplete_event`. That is a completeness diagnostic, not a
  // coverage gap: the projection still claims the field.
  permissionAnswerAccepted: {
    action: { requestId: 'coverage-request' },
    event: { author: 'user', refs: { toolCallId: 'coverage-tool' } },
  },
  permissionClosureAccepted: {
    action: { requestId: 'coverage-request', reason: 'timed_out' },
  },
  userQuestionRequest: {
    action: {
      requestId: 'coverage-question',
      toolUseId: 'coverage-question-tool',
      questions: [{ question: 'Choose', options: [{ label: 'Extend' }] }],
    },
    event: { refs: { toolCallId: 'coverage-question-tool' } },
  },
  userQuestionAnswerAccepted: {
    action: { requestId: 'coverage-question' },
    event: { author: 'user', refs: { toolCallId: 'coverage-question-tool' } },
  },
  transferToAgent: { action: 'agent-b' },
  // The terminal fact is one of the actions that does own a row.
  endInvocation: { action: true },
  tokenUsage: { action: { input: 10, output: 5 } },
  toolDispatch: {
    action: {
      protocol: 't1_after_preflight_v1',
      operationId: 'coverage-op',
      providerToolCallId: 'coverage-tool',
      toolName: 'Bash',
      canonicalArgsHash: 'sha256:args',
      recoveryMode: 'reconcile',
    },
    event: { refs: { toolCallId: 'coverage-tool', operationId: 'coverage-op' } },
  },
  toolRecovery: {
    action: {
      kind: 'maka.tool.reconcile_result',
      version: 1,
      payload: {
        protocol: 'tool_reconcile_v1',
        operationId: 'coverage-op',
        observation: 'unreadable',
        observationSchema: 'state_identity_v1',
        observationDigest:
          'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
    },
    event: { refs: { toolCallId: 'coverage-tool', operationId: 'coverage-op' } },
  },
  workspaceFact: {
    action: {
      kind: 'maka.workspace.epoch_opened',
      version: 1,
      payload: {
        protocol: 'workspace_epoch_opened_v1',
        repositoryId: `repository_${'1'.repeat(32)}`,
        workspaceId: `workspace_${'2'.repeat(32)}`,
        workspaceEpochId: `epoch_${'3'.repeat(32)}`,
        workspaceInstanceId: `instance_${'4'.repeat(32)}`,
        initialWorkspaceVersionId: `version_${'5'.repeat(32)}`,
        mode: 'managed_worktree',
        objectFormat: 'sha1',
        sourceCommitOid: '1'.repeat(40),
        sourceTreeOid: '2'.repeat(40),
        materializationProfileDigest: `sha256:${'3'.repeat(64)}`,
        materializationSemantics: 'git_tree_materialized_with_fixed_config_v1',
        policyHash: `sha256:${'4'.repeat(64)}`,
      },
    },
  },
  runtimeProtocol: { action: { toolBoundary: 't1_after_preflight_v1' } },
};

describe('RuntimeEventActions projection coverage', () => {
  for (const [field, sample] of Object.entries(ACTION_COVERAGE_SAMPLES)) {
    test(`actions.${field} projects without an unclaimed-event diagnostic`, () => {
      const actions = { [field]: sample.action } as RuntimeEventActions;
      // Guards an entry that names a field but leaves it absent at runtime.
      expect(field in actions).toBe(true);
      const out = projectRuntimeEventsToStoredMessages([ev({ ...sample.event, actions })], {
        runHeaders: [header],
      });

      expect(out.diagnostics.filter(isUnclaimedRuntimeEventDiagnostic)).toEqual([]);
    });
  }
});

describe('compareRuntimeReadModelMessages', () => {
  test('treats nested JSON with different property order as compatible', () => {
    const projected = projectRuntimeEventsToStoredMessages(
      [
        ev({
          id: 'evt-tool-call-json',
          role: 'model',
          author: 'agent',
          content: {
            kind: 'function_call',
            id: 'tool-json',
            name: 'JsonTool',
            args: { beta: 2, alpha: { z: 3, a: 1 } },
          },
        }),
        ev({
          id: 'evt-tool-result-json',
          role: 'tool',
          author: 'tool',
          content: {
            kind: 'function_response',
            id: 'tool-json',
            name: 'JsonTool',
            result: { kind: 'json', value: { outer: { y: 2, x: 1 }, list: [{ b: 2, a: 1 }] } },
          },
        }),
      ],
      { runHeaders: [header] },
    );
    const legacy: StoredMessage[] = [
      {
        type: 'tool_call',
        id: 'tool-json',
        turnId,
        ts,
        toolName: 'JsonTool',
        args: { alpha: { a: 1, z: 3 }, beta: 2 },
      },
      {
        type: 'tool_result',
        id: 'different-result-id',
        turnId,
        ts,
        toolUseId: 'tool-json',
        isError: false,
        content: { kind: 'json', value: { list: [{ a: 1, b: 2 }], outer: { x: 1, y: 2 } } },
      },
    ];

    const result = compareRuntimeReadModelMessages(projected.messages, legacy);

    expect(result.compatible).toBe(true);
    expect(result.diagnostics).toEqual([]);
  });

  test('rejects a mismatched tool activity kind', () => {
    const projected: StoredMessage[] = [
      {
        type: 'tool_call',
        id: 'tool-kind',
        turnId,
        ts,
        toolName: 'CustomTool',
        activityKind: 'read',
        args: {},
      },
    ];
    const legacy: StoredMessage[] = [
      {
        ...(projected[0] as Extract<StoredMessage, { type: 'tool_call' }>),
        activityKind: 'command',
      },
    ];

    expect(compareRuntimeReadModelMessages(projected, legacy).compatible).toBe(false);
  });

  test('rejects mismatched replay-critical token usage fields', () => {
    const usage: Extract<StoredMessage, { type: 'token_usage' }> = {
      type: 'token_usage',
      id: 'usage-1',
      turnId,
      ts,
      input: 100,
      output: 25,
      runtimeSteps: 3,
      contextRemaining: 9000,
      providerRequestTraceId: 'provider-trace-1',
    };

    expect(
      compareRuntimeReadModelMessages([usage], [{ ...usage, runtimeSteps: 4 }]).compatible,
    ).toBe(false);
    expect(
      compareRuntimeReadModelMessages([usage], [{ ...usage, contextRemaining: 8000 }]).compatible,
    ).toBe(false);
    expect(
      compareRuntimeReadModelMessages(
        [usage],
        [{ ...usage, providerRequestTraceId: 'provider-trace-2' }],
      ).compatible,
    ).toBe(false);
  });

  test('rejects missing tool result and assistant text cases', () => {
    const projected = projectRuntimeEventsToStoredMessages(baseEvents(), { runHeaders: [header] });
    const missing = projected.messages.filter(
      (message) => message.type !== 'tool_result' && message.type !== 'assistant',
    );
    const result = compareRuntimeReadModelMessages(missing, equivalentLegacyMessages());

    expect(result.compatible).toBe(false);
    expect(result.diagnostics.map((diag) => diag.code)).toEqual([
      'missing_legacy_message',
      'missing_legacy_message',
    ]);
  });
});

describe('SessionManager read behavior', () => {
  test('getMessages requires RuntimeReadModel stores instead of reading SessionStore messages directly', async () => {
    const messages: StoredMessage[] = equivalentLegacyMessages();
    const store = new ReadOnlyStore(messages);
    const manager = new SessionManager({
      store,
      backends: new BackendRegistry(),
      newId: () => 'id',
      now: () => ts,
    });

    await expectRejects(
      manager.getMessages(sessionId),
      /RuntimeReadModel requires AgentRunStore and RuntimeEventStore/,
    );
    expect(store.readMessagesCalls).toBe(0);
  });
});

class ReadOnlyStore implements SessionStore {
  readMessagesCalls = 0;

  constructor(private readonly messages: StoredMessage[]) {}

  async createSubagent(
    _input: CreateSessionInput,
  ): Promise<{ header: SessionHeader; created: boolean }> {
    throw new Error('not implemented');
  }

  async create(_input: CreateSessionInput): Promise<SessionHeader> {
    throw new Error('not implemented');
  }

  async setExecutionBoundaryKind(): Promise<never> {
    throw new Error('not implemented');
  }

  async readExecutionBoundary(): Promise<never> {
    throw new Error('not implemented');
  }

  async list(_filter?: SessionListFilter): Promise<SessionSummary[]> {
    return [];
  }

  async readHeader(id: string): Promise<SessionHeader> {
    return makeHeader(id);
  }

  async readMessages(_sessionId: string): Promise<StoredMessage[]> {
    this.readMessagesCalls += 1;
    return [...this.messages];
  }

  async listTurns(_sessionId: string): Promise<TurnRecord[]> {
    return deriveTurnRecords(this.messages);
  }

  async appendMessage(_sessionId: string, _m: StoredMessage): Promise<void> {
    throw new Error('not implemented');
  }

  async appendMessages(_sessionId: string, _ms: StoredMessage[]): Promise<void> {
    throw new Error('not implemented');
  }

  async updateHeader(id: string, patch: Partial<SessionHeader>): Promise<SessionHeader> {
    return { ...makeHeader(id), ...patch };
  }

  async markSessionReadThrough(id: string, readThroughTs: number): Promise<SessionHeader> {
    const header = makeHeader(id);
    if (
      !Number.isFinite(readThroughTs) ||
      !header.hasUnread ||
      (header.lastMessageAt !== undefined && header.lastMessageAt > readThroughTs)
    )
      return header;
    return { ...header, hasUnread: false };
  }

  async archive(_sessionId: string): Promise<void> {}
  async unarchive(_sessionId: string): Promise<void> {}
  async setFlagged(_sessionId: string, _isFlagged: boolean): Promise<void> {}
  async rename(_sessionId: string, _name: string): Promise<void> {}
  async remove(_sessionId: string): Promise<void> {}
}

async function expectRejects(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error instanceof Error ? error.message : String(error)).toMatch(pattern);
    return;
  }
  throw new Error(`Expected promise to reject with ${pattern}`);
}

function archivedStatus(message: StoredMessage | undefined): string | undefined {
  if (message?.type !== 'tool_result') return undefined;
  return message.content.kind === 'archived_tool_result' ? message.content.status : undefined;
}

function makeHeader(id: string): SessionHeader {
  return {
    id,
    workspaceRoot: '/tmp/work',
    cwd: '/tmp/work',
    createdAt: ts,
    lastUsedAt: ts,
    name: 'Session',
    titleIsManual: true,
    isFlagged: false,
    labels: [],
    isArchived: false,
    status: 'active',
    hasUnread: false,
    backend: 'fake',
    llmConnectionSlug: 'fake',
    connectionLocked: false,
    model: 'fake-model',
    permissionMode: 'ask',
    schemaVersion: 1,
  };
}

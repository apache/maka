import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { expect } from '../test-helpers.js';
import {
  decodeMessageContent,
  messageContentsEqual,
  normalizeMessageContent,
  type SessionEvent,
} from '../events.js';
import { INTERACTION_ID_MAX_BYTES, INTERACTION_TOOL_NAME_MAX_BYTES } from '../interaction.js';
import {
  RUNTIME_EVENT_AUTHORS,
  RUNTIME_EVENT_CONTENT_KINDS,
  RUNTIME_EVENT_ROLES,
  RUNTIME_EVENT_STATUSES,
  TERMINAL_RUNTIME_EVENT_STATUSES,
  createRuntimeEventId,
  decodePersistedRuntimeEvent,
  decodeRuntimeEvent,
  isRuntimeEventAuthor,
  isRuntimeEventRole,
  isRuntimeEventStatus,
  isTerminalRuntimeEvent,
  isTerminalRuntimeEventStatus,
  isPartialRuntimeEvent,
  runtimeEventHasModelVisibleContent,
  type RuntimeEvent,
  type RuntimeEventActions,
  type RuntimeEventContent,
} from '../runtime-event.js';
import { decodeStoredMessageForRecovery } from '../session.js';

/** Minimal valid RuntimeEvent; callers spread overrides on top. */
function baseEvent(overrides: Partial<RuntimeEvent> = {}): RuntimeEvent {
  return {
    id: 'evt-1',
    invocationId: 'inv-1',
    runId: 'run-1',
    sessionId: 'sess-1',
    turnId: 'turn-1',
    ts: 100,
    partial: false,
    role: 'model',
    author: 'agent',
    ...overrides,
  };
}

interface RuntimeEventValidationCorpus {
  baseEvent: Record<string, unknown>;
  cases: Array<{
    name: string;
    accepted: boolean;
    overrides: Record<string, unknown>;
  }>;
}

const runtimeEventValidationCorpus = JSON.parse(
  readFileSync(
    new URL('../../src/__tests__/fixtures/runtime-event-validation-corpus.json', import.meta.url),
    'utf8',
  ),
) as RuntimeEventValidationCorpus;

test('Core decoder matches the shared RuntimeEvent validation corpus', () => {
  for (const entry of runtimeEventValidationCorpus.cases) {
    const event = { ...runtimeEventValidationCorpus.baseEvent, ...entry.overrides };
    if (entry.accepted) {
      assert.doesNotThrow(() => decodeRuntimeEvent(event), entry.name);
    } else {
      assert.throws(() => decodeRuntimeEvent(event), /Invalid RuntimeEvent schema/, entry.name);
    }
  }
});

test('Stored assistant reasoning parts survive recovery decoding', () => {
  const parts = [
    {
      text: 'first summary',
      providerOptions: {
        openai: { itemId: 'rs_first', reasoningEncryptedContent: 'encrypted-first' },
      },
    },
    {
      text: 'second summary',
      providerOptions: {
        openai: { itemId: 'rs_second', reasoningEncryptedContent: 'encrypted-second' },
      },
    },
  ];
  const stored = decodeStoredMessageForRecovery({
    type: 'assistant',
    id: 'message-1',
    turnId: 'turn-1',
    ts: 1,
    text: 'answer',
    thinking: { text: 'first summarysecond summary', parts },
    modelId: 'ark-code-latest',
  });

  assert.equal(stored.type, 'assistant');
  if (stored.type !== 'assistant') throw new Error('unreachable');
  assert.deepEqual(stored.thinking?.parts, parts);
});

describe('RuntimeEvent role / author / status enums', () => {
  test('locks the role enum and guard', () => {
    expect(RUNTIME_EVENT_ROLES).toEqual(['user', 'model', 'tool', 'system']);
    expect(isRuntimeEventRole('model')).toBe(true);
    expect(isRuntimeEventRole('assistant')).toBe(false);
    expect(isRuntimeEventRole(123)).toBe(false);
  });

  test('locks the author enum (agent ≠ model) and guard', () => {
    expect(RUNTIME_EVENT_AUTHORS).toEqual(['user', 'host', 'agent', 'tool', 'system']);
    expect(isRuntimeEventAuthor('host')).toBe(true);
    expect(isRuntimeEventAuthor('agent')).toBe(true);
    expect(isRuntimeEventAuthor('model')).toBe(false);
    expect(isRuntimeEventAuthor(null)).toBe(false);
  });

  test('locks the status enum, terminal subset, and guards', () => {
    expect(RUNTIME_EVENT_STATUSES).toEqual([
      'streaming',
      'completed',
      'failed',
      'aborted',
      'cancelled',
    ]);
    expect(TERMINAL_RUNTIME_EVENT_STATUSES).toEqual([
      'completed',
      'failed',
      'aborted',
      'cancelled',
    ]);
    expect(isRuntimeEventStatus('streaming')).toBe(true);
    expect(isRuntimeEventStatus('idle')).toBe(false);
    expect(isTerminalRuntimeEventStatus('completed')).toBe(true);
    expect(isTerminalRuntimeEventStatus('streaming')).toBe(false);
    expect(isTerminalRuntimeEventStatus('nope')).toBe(false);
  });

  test('content kind list matches the discriminated union', () => {
    expect(RUNTIME_EVENT_CONTENT_KINDS).toEqual([
      'text',
      'thinking',
      'function_call',
      'function_response',
      'error',
    ]);
  });
});

describe('continuation-start protocol', () => {
  test('accepts only the replay projection version defined by v2', () => {
    const continuationStart = {
      protocol: 'continuation_start_v2',
      provenance: 'runtime_admission',
      claimId: 'claim-1',
      boundaryDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      immediateSource: {
        sessionId: 'sess-1',
        invocationId: 'inv-source',
        runId: 'run-source',
        turnId: 'turn-source',
        highWater: 1,
        prefixDigest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      },
      replayManifestDigest:
        'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      providerProjectionVersion: 1,
      providerReplayDigest:
        'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    } as const;

    assert.deepEqual(
      decodeRuntimeEvent(
        baseEvent({
          role: 'system',
          author: 'system',
          content: undefined,
          actions: { continuationStart },
        }),
      ).actions?.continuationStart,
      continuationStart,
    );
    assert.throws(
      () =>
        decodeRuntimeEvent({
          ...baseEvent({ role: 'system', author: 'system', content: undefined }),
          actions: {
            continuationStart: { ...continuationStart, providerProjectionVersion: 2 },
          },
        }),
      /RuntimeEvent schema/,
    );
  });
});

describe('RuntimeEvent content variants', () => {
  test('preserves sent inline references as message identity', () => {
    const inlineReferences = [
      { kind: 'skill', value: '/skill:writer', label: 'Writer', start: 8 },
      {
        kind: 'workspace_file',
        value: '@packages/ui/src/chat turn.tsx',
        label: 'chat turn.tsx',
        start: 22,
      },
    ] as const;
    const decoded = decodeMessageContent({
      text: 'Inspect /skill:writer @packages/ui/src/chat turn.tsx',
      inlineReferences: [...inlineReferences],
    });

    assert.deepEqual(decoded.inlineReferences, inlineReferences);
    assert.notEqual(decoded.inlineReferences, inlineReferences);
    assert.notEqual(decoded.inlineReferences?.[0], inlineReferences[0]);
    assert.equal(
      messageContentsEqual(decoded, {
        text: 'Inspect /skill:writer @packages/ui/src/chat turn.tsx',
        inlineReferences: [...inlineReferences],
      }),
      true,
    );
    assert.equal(
      messageContentsEqual(decoded, {
        text: 'Inspect /skill:writer @packages/ui/src/chat turn.tsx',
        inlineReferences: [
          { ...inlineReferences[0]!, label: 'Renamed Writer' },
          inlineReferences[1]!,
        ],
      }),
      false,
    );
  });

  test('rejects an empty sent inline-reference value before UI projection', () => {
    assert.throws(
      () =>
        decodeMessageContent({
          text: 'hello',
          inlineReferences: [{ kind: 'skill', value: '', label: 'Writer', start: 0 }],
        }),
      /Invalid MessageContent/,
    );
  });

  test('rejects sent inline references outside their bounded kind grammar', () => {
    const invalidReferences = [
      { kind: 'skill', value: 'writer', label: 'Writer' },
      { kind: 'skill', value: `/skill:${'a'.repeat(4_090)}`, label: 'Writer' },
      { kind: 'workspace_file', value: '@../secret', label: 'secret' },
      { kind: 'workspace_file', value: '@src/a.ts', label: '' },
      { kind: 'workspace_file', value: '@src/a.ts', label: 'a'.repeat(201) },
    ];
    for (const reference of invalidReferences) {
      assert.throws(
        () =>
          decodeMessageContent({
            text: reference.value,
            inlineReferences: [{ ...reference, start: 0 }],
          }),
        /Invalid MessageContent/,
      );
    }
    assert.throws(
      () =>
        decodeMessageContent({
          text: 'hello',
          inlineReferences: Array.from({ length: 33 }, () => ({
            kind: 'skill',
            value: '/skill:writer',
            label: 'Writer',
            start: 0,
          })),
        }),
      /Invalid MessageContent/,
    );
  });

  test('preserves the exact occurrence selected as an inline reference', () => {
    const text = 'literal @docs/a.ts then selected @docs/a.ts';
    const selectedStart = text.lastIndexOf('@docs/a.ts');
    assert.deepEqual(
      decodeMessageContent({
        text,
        inlineReferences: [
          {
            kind: 'workspace_file',
            value: '@docs/a.ts',
            label: 'a.ts',
            start: selectedStart,
          },
        ],
      }).inlineReferences,
      [
        {
          kind: 'workspace_file',
          value: '@docs/a.ts',
          label: 'a.ts',
          start: selectedStart,
        },
      ],
    );
  });

  test('rejects missing, mismatched, or overlapping reference occurrences', () => {
    const invalid = [
      [{ kind: 'skill', value: '/skill:writer', label: 'Writer' }],
      [{ kind: 'skill', value: '/skill:writer', label: 'Writer', start: 1 }],
      [
        { kind: 'skill', value: '/skill:writer', label: 'Writer', start: 0 },
        { kind: 'skill', value: '/skill:writer', label: 'Writer', start: 0 },
      ],
    ];
    for (const inlineReferences of invalid) {
      assert.throws(
        () => decodeMessageContent({ text: '/skill:writer', inlineReferences }),
        /Invalid MessageContent/,
      );
    }
  });

  test('preserves an explicit empty reference projection as message identity', () => {
    assert.deepEqual(normalizeMessageContent({ text: 'plain', inlineReferences: [] }), {
      text: 'plain',
      inlineReferences: [],
    });
    assert.equal(
      messageContentsEqual({ text: 'plain', inlineReferences: [] }, { text: 'plain' }),
      false,
    );
  });

  test('owns canonical MessageContent decoding, copying, and equality', () => {
    const attachments = [
      {
        kind: 'code' as const,
        name: 'b.ts',
        mimeType: 'text/typescript',
        bytes: 2,
        ref: { kind: 'workspace_file' as const, relativePath: 'b.ts' },
      },
      {
        kind: 'code' as const,
        name: 'a.ts',
        mimeType: 'text/typescript',
        bytes: 1,
        ref: { kind: 'workspace_file' as const, relativePath: 'a.ts' },
      },
    ];
    const quotes = [
      { text: 'first', label: 'Assistant', sourceTurnId: 'turn-1' },
      { text: 'second', sourceTurnId: 'turn-2' },
    ];
    assert.deepEqual(normalizeMessageContent({ text: 'model', displayText: 'model' }), {
      text: 'model',
    });
    assert.deepEqual(normalizeMessageContent({ text: 'model', attachments: [] }), {
      text: 'model',
    });
    assert.deepEqual(normalizeMessageContent({ text: 'model', quotes: [] }), {
      text: 'model',
    });
    const decoded = decodeMessageContent({ text: 'model', attachments, quotes });
    assert.deepEqual(decoded.attachments, attachments);
    assert.deepEqual(decoded.quotes, quotes);
    assert.notEqual(decoded.attachments, attachments);
    assert.notEqual(decoded.attachments?.[0], attachments[0]);
    assert.notEqual(decoded.attachments?.[0]?.ref, attachments[0]?.ref);
    assert.notEqual(decoded.quotes, quotes);
    assert.notEqual(decoded.quotes?.[0], quotes[0]);
    assert.equal(messageContentsEqual(decoded, { text: 'model', attachments, quotes }), true);
    assert.equal(
      messageContentsEqual(decoded, {
        text: 'model',
        attachments: [...attachments].reverse(),
        quotes,
      }),
      false,
    );
    assert.equal(
      messageContentsEqual(decoded, { text: 'model', attachments, quotes: [...quotes].reverse() }),
      false,
    );
    assert.equal(
      messageContentsEqual(decoded, {
        text: 'model',
        attachments,
        quotes: [{ ...quotes[0]!, sourceTurnId: 'turn-other' }, quotes[1]!],
      }),
      false,
    );
    assert.throws(() => decodeMessageContent({ text: 'model', extra: true }), TypeError);
    assert.throws(
      () =>
        decodeMessageContent({
          text: 'model',
          attachments: [{ ...attachments[0]!, ref: { kind: 'workspace_file', relativePath: 1 } }],
        }),
      TypeError,
    );
    assert.throws(
      () =>
        decodeMessageContent({
          text: 'model',
          attachments: [{ ...attachments[0]!, bytes: 1.5 }],
        }),
      TypeError,
    );
    for (const quote of [
      { text: 1 },
      { text: 'excerpt', label: 1 },
      { text: 'excerpt', sourceTurnId: 1 },
      { text: 'excerpt', extra: true },
    ]) {
      assert.throws(() => decodeMessageContent({ text: 'model', quotes: [quote] }), TypeError);
    }
    assert.deepEqual(
      decodeRuntimeEvent(
        baseEvent({
          role: 'user',
          author: 'user',
          content: {
            kind: 'text',
            text: 'model',
            displayText: 'model',
            attachments: [],
            quotes,
          },
        }),
      ).content,
      { kind: 'text', text: 'model', quotes },
    );
    const event = decodeRuntimeEvent(
      baseEvent({ content: { kind: 'text', text: 'model', quotes } }),
    );
    assert.notEqual(
      event.content && 'quotes' in event.content ? event.content.quotes : undefined,
      quotes,
    );
    assert.notEqual(
      event.content && 'quotes' in event.content ? event.content.quotes?.[0] : undefined,
      quotes[0],
    );
    const stored = decodeStoredMessageForRecovery({
      type: 'user',
      id: 'message-1',
      turnId: 'turn-1',
      ts: 1,
      text: 'model',
      displayText: 'model',
      attachments: [],
      quotes,
    });
    assert.deepEqual(stored, {
      type: 'user',
      id: 'message-1',
      turnId: 'turn-1',
      ts: 1,
      text: 'model',
      quotes,
    });
    assert.equal(stored.type, 'user');
    if (stored.type !== 'user') throw new Error('unreachable');
    assert.notEqual(stored.quotes, quotes);
    assert.notEqual(stored.quotes?.[0], quotes[0]);
    assert.throws(
      () =>
        decodeStoredMessageForRecovery({
          type: 'user',
          id: 'message-1',
          turnId: 'turn-1',
          ts: 1,
          text: 'model',
          quotes: [{ text: 'excerpt', sourceTurnId: 1 }],
        }),
      /Invalid stored message schema/,
    );
  });

  test('text content carries a string body', () => {
    const content: RuntimeEventContent = { kind: 'text', text: 'hello' };
    if (content.kind !== 'text') throw new Error('unreachable');
    expect(content.text).toBe('hello');
  });

  test('text content can carry attachment refs without changing its kind', () => {
    const content: RuntimeEventContent = {
      kind: 'text',
      text: 'see attached',
      attachments: [
        {
          kind: 'image',
          name: 'chart.png',
          mimeType: 'image/png',
          bytes: 123,
          ref: {
            kind: 'session_file',
            sessionId: 'sess-1',
            relativePath: 'attachments/chart.png',
          },
        },
      ],
    };
    if (content.kind !== 'text') throw new Error('unreachable');
    expect(content.attachments?.[0]?.name).toBe('chart.png');
  });

  test('thinking content may carry a replay signature', () => {
    const content: RuntimeEventContent = {
      kind: 'thinking',
      text: 'reasoning',
      signature: 'sig',
    };
    if (content.kind !== 'thinking') throw new Error('unreachable');
    expect(content.signature).toBe('sig');
  });

  test('function_call and function_response share an id', () => {
    const call: RuntimeEventContent = {
      kind: 'function_call',
      id: 'tc-1',
      name: 'Read',
      args: { path: '/x' },
      providerOptions: { google: { thoughtSignature: 'sig' } },
    };
    const response: RuntimeEventContent = {
      kind: 'function_response',
      id: 'tc-1',
      name: 'Read',
      result: 'ok',
      isError: false,
    };
    if (call.kind !== 'function_call' || response.kind !== 'function_response') {
      throw new Error('unreachable');
    }
    expect(call.id).toBe(response.id);
    expect(decodeRuntimeEvent(baseEvent({ content: call })).content).toEqual(call);
    expect(response.isError).toBe(false);
  });
});

describe('RuntimeEvent actions', () => {
  test('normalizes legacy permission requests only for persisted reads', () => {
    const permissionRequest = {
      requestId: 'pr-1',
      toolUseId: 'tc-1',
      toolName: 'Bash',
      category: 'shell_unsafe',
      reason: 'shell_dangerous',
      args: { command: 'rm foo' },
    };
    const legacyEvent = baseEvent({ actions: { permissionRequest } as never });
    assert.throws(() => decodeRuntimeEvent(legacyEvent), /Invalid RuntimeEvent schema/);
    assert.deepEqual(decodePersistedRuntimeEvent(legacyEvent).actions?.permissionRequest, {
      ...permissionRequest,
      kind: 'tool_permission',
      rememberForTurnAllowed: false,
    });
    assert.throws(
      () =>
        decodePersistedRuntimeEvent(
          baseEvent({
            actions: {
              permissionRequest: { ...permissionRequest, kind: 'tool_permission' },
            } as never,
          }),
        ),
      /Invalid RuntimeEvent schema/,
    );
  });

  test('a terminal action can carry endInvocation + tokenUsage', () => {
    const actions: RuntimeEventActions = {
      endInvocation: true,
      tokenUsage: { input: 10, output: 5, costUsd: 0.001 },
    };
    expect(actions.endInvocation).toBe(true);
    expect(actions.tokenUsage?.input).toBe(10);
  });

  test('permission and user-question interactions are first-class actions', () => {
    const actions: RuntimeEventActions = {
      permissionRequest: {
        kind: 'tool_permission',
        requestId: 'pr-1',
        toolUseId: 'tc-1',
        toolName: 'Bash',
        category: 'shell_unsafe',
        reason: 'shell_dangerous',
        args: { command: 'rm foo' },
        rememberForTurnAllowed: true,
      },
      permissionDecision: { requestId: 'pr-1', decision: 'deny' },
      permissionAnswerAccepted: { requestId: 'hosted-pr-1' },
      userQuestionAnswerAccepted: { requestId: 'question-1' },
    };
    expect(actions.permissionRequest?.category).toBe('shell_unsafe');
    expect(actions.permissionDecision?.decision).toBe('deny');
    assert.deepEqual(decodeRuntimeEvent(baseEvent({ actions })).actions?.permissionDecision, {
      requestId: 'pr-1',
      decision: 'deny',
    });
    const decodedActions = decodeRuntimeEvent(baseEvent({ actions })).actions;
    for (const [accepted, requestId] of [
      [decodedActions?.permissionAnswerAccepted, 'hosted-pr-1'],
      [decodedActions?.userQuestionAnswerAccepted, 'question-1'],
    ] as const) {
      assert.deepEqual(accepted, { requestId });
      assert.ok(accepted);
      assert.equal(Object.hasOwn(accepted, 'requestId'), true);
      assert.equal(Object.hasOwn(accepted, 'decision'), false);
    }

    for (const invalidAcceptedAction of [
      { permissionAnswerAccepted: { requestId: 'pr-1', extra: true } },
      { userQuestionAnswerAccepted: { requestId: 'question-1', extra: true } },
      { permissionAnswerAccepted: Object.create({ requestId: 'inherited-pr-1' }) },
      { userQuestionAnswerAccepted: { requestId: 'x'.repeat(257) } },
    ]) {
      assert.throws(() =>
        decodeRuntimeEvent({
          ...baseEvent(),
          actions: invalidAcceptedAction,
        }),
      );
    }
  });

  test('permission closure acknowledgement has a narrow durable shape', () => {
    const sessionEvent: SessionEvent = {
      type: 'permission_closure_ack',
      id: 'evt-closure-1',
      turnId: 'turn-1',
      ts: 100,
      requestId: 'hosted-pr-1',
      toolUseId: 'tool-use-1',
      reason: 'timed_out',
    };

    const decoded = decodeRuntimeEvent(
      baseEvent({
        actions: {
          permissionClosureAccepted: {
            requestId: sessionEvent.requestId,
            reason: sessionEvent.reason,
          },
        },
      }),
    ).actions?.permissionClosureAccepted;
    assert.deepEqual(decoded, { requestId: 'hosted-pr-1', reason: 'timed_out' });
    assert.ok(decoded);

    for (const permissionClosureAccepted of [
      { requestId: 'pr-1', reason: 'timed_out', extra: true },
      { requestId: 'x'.repeat(INTERACTION_ID_MAX_BYTES + 1), reason: 'timed_out' },
      { requestId: 'pr-1', reason: 'cancelled' },
    ]) {
      assert.throws(() =>
        decodeRuntimeEvent(baseEvent({ actions: { permissionClosureAccepted } as never })),
      );
    }

    const conflictingActions: RuntimeEventActions[] = [
      { permissionAnswerAccepted: { requestId: 'hosted-pr-1' } },
      {
        permissionRequest: {
          kind: 'tool_permission',
          requestId: 'hosted-pr-1',
          toolUseId: 'tool-use-1',
          toolName: 'Bash',
          category: 'shell_unsafe',
          reason: 'shell_dangerous',
          args: { command: 'rm foo' },
          rememberForTurnAllowed: true,
        },
      },
      { endInvocation: true },
    ];
    for (const conflictingAction of conflictingActions) {
      assert.throws(() =>
        decodeRuntimeEvent(
          baseEvent({
            actions: {
              permissionClosureAccepted: {
                requestId: 'hosted-pr-1',
                reason: 'timed_out',
              },
              ...conflictingAction,
            },
          }),
        ),
      );
    }
  });

  test('permission decisions optionally retain a bounded tool name', () => {
    const permissionDecision = {
      requestId: 'pr-1',
      decision: 'allow' as const,
      rememberForTurn: true,
      toolName: 'Bash',
    };

    assert.deepEqual(
      decodeRuntimeEvent(baseEvent({ actions: { permissionDecision } })).actions
        ?.permissionDecision,
      permissionDecision,
    );

    for (const invalidPermissionDecision of [
      { requestId: 'pr-1', decision: 'allow', toolName: '' },
      {
        requestId: 'pr-1',
        decision: 'allow',
        toolName: 'x'.repeat(INTERACTION_TOOL_NAME_MAX_BYTES + 1),
      },
      { requestId: 'pr-1', decision: 'allow', toolName: 'Bash', extra: true },
    ]) {
      assert.throws(() =>
        decodeRuntimeEvent({
          ...baseEvent(),
          actions: { permissionDecision: invalidPermissionDecision },
        }),
      );
    }
  });

  test('state/artifact deltas accept primitive values', () => {
    const actions: RuntimeEventActions = {
      stateDelta: { retries: 1 },
      artifactDelta: { 'out.md': 2048 },
    };
    expect(actions.stateDelta?.retries).toBe(1);
    expect(actions.artifactDelta?.['out.md']).toBe(2048);
  });
});

describe('isTerminalRuntimeEvent', () => {
  test('classifies terminal status and explicit invocation completion', () => {
    for (const status of TERMINAL_RUNTIME_EVENT_STATUSES) {
      expect(isTerminalRuntimeEvent(baseEvent({ status }))).toBe(true);
    }
    for (const event of [
      baseEvent({ content: { kind: 'text', text: 'hi' } }),
      baseEvent({ status: 'streaming' }),
      baseEvent({ actions: { endInvocation: false } }),
    ]) {
      expect(isTerminalRuntimeEvent(event)).toBe(false);
    }
    expect(isTerminalRuntimeEvent(baseEvent({ actions: { endInvocation: true } }))).toBe(true);
  });
});

describe('isPartialRuntimeEvent', () => {
  test('reflects the partial flag exactly', () => {
    expect(isPartialRuntimeEvent(baseEvent({ partial: true }))).toBe(true);
    expect(isPartialRuntimeEvent(baseEvent({ partial: false }))).toBe(false);
  });
});

describe('runtimeEventHasModelVisibleContent', () => {
  test('retains nested CodeMode identity while excluding its content from model replay', () => {
    const event = decodeRuntimeEvent(
      baseEvent({
        origin: 'code_mode',
        modelVisibility: 'hidden',
        content: { kind: 'function_call', id: 'nested-1', name: 'Read', args: { path: 'a.ts' } },
        refs: {
          toolCallId: 'nested-1',
          operationId: 'nested-op-1',
          parentToolCallId: 'exec-1',
          parentOperationId: 'exec-op-1',
        },
      }),
    );

    assert.equal(event.origin, 'code_mode');
    assert.equal(event.modelVisibility, 'hidden');
    assert.equal(event.refs?.parentToolCallId, 'exec-1');
    assert.equal(event.refs?.parentOperationId, 'exec-op-1');
    assert.equal(runtimeEventHasModelVisibleContent(event), false);
  });

  test('classifies model-visible content by semantic kind', () => {
    const visible = [
      baseEvent({ role: 'user', content: { kind: 'text', text: 'hi' } }),
      baseEvent({ content: { kind: 'thinking', text: 'r' } }),
      baseEvent({ content: { kind: 'function_call', id: '1', name: 'Read', args: {} } }),
      baseEvent({
        content: {
          kind: 'function_response',
          id: '1',
          name: 'Bash',
          result: 'boom',
          isError: true,
        },
      }),
    ];
    for (const event of visible) expect(runtimeEventHasModelVisibleContent(event)).toBe(true);

    const hidden = [
      baseEvent({ content: { kind: 'text', text: '' } }),
      baseEvent({ content: { kind: 'error', message: 'upstream failed' } }),
      baseEvent({ actions: { tokenUsage: { input: 1, output: 1 } } }),
      baseEvent({ refs: { toolCallId: 'tc-1' } }),
    ];
    for (const event of hidden) expect(runtimeEventHasModelVisibleContent(event)).toBe(false);
  });
});

describe('createRuntimeEventId', () => {
  test('honors the prefix and returns a string', () => {
    const id = createRuntimeEventId('turn');
    expect(typeof id).toBe('string');
    expect(id.startsWith('turn_')).toBe(true);
  });

  test('uses the default prefix when none is given', () => {
    expect(createRuntimeEventId().startsWith('rt-event_')).toBe(true);
  });

  test('never collides within a process', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 500; i += 1) ids.add(createRuntimeEventId());
    expect(ids.size).toBe(500);
  });
});

describe('RuntimeEvent shape compile-time contract', () => {
  test('accepts a provider-request trace reference and rejects a non-string reference', () => {
    const event = baseEvent({ refs: { providerRequestTraceId: 'provider-trace-1' } });
    expect(decodeRuntimeEvent(event).refs?.providerRequestTraceId).toBe('provider-trace-1');
    assert.throws(() =>
      decodeRuntimeEvent({
        ...event,
        refs: { providerRequestTraceId: 123 },
      }),
    );
  });

  test('a full user event satisfies the type', () => {
    const event: RuntimeEvent = {
      id: 'evt-u1',
      invocationId: 'inv-1',
      runId: 'run-1',
      sessionId: 'sess-1',
      turnId: 'turn-1',
      ts: 1,
      partial: false,
      role: 'user',
      author: 'user',
      content: { kind: 'text', text: 'hello' },
    };
    expect(event.role).toBe('user');
    expect(isTerminalRuntimeEvent(event)).toBe(false);
  });

  test('a terminal agent event with branch + refs satisfies the type', () => {
    const event: RuntimeEvent = {
      id: 'evt-t1',
      invocationId: 'inv-1',
      runId: 'run-1',
      sessionId: 'sess-1',
      turnId: 'turn-1',
      ts: 99,
      branch: 'main',
      partial: false,
      role: 'model',
      author: 'agent',
      status: 'completed',
      actions: { endInvocation: true, tokenUsage: { input: 1, output: 2 } },
      refs: { storedMessageId: 'm1', toolCallId: 'tc-1' },
    };
    expect(isTerminalRuntimeEvent(event)).toBe(true);
    expect(event.branch).toBe('main');
  });
});

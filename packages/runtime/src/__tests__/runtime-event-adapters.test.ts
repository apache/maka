/**
 * Tests for runtime-event-adapters and model-history projection.
 *
 * Run: `npm --workspace @maka/runtime run test`
 *
 * Proves the policy from the work node body:
 *   - partial model chunks are not included in durable model history;
 *   - tool/function response events can be included when model-visible;
 *   - diagnostics/token/permission-only events are excluded;
 *   - legacy user/assistant/system stored messages convert safely.
 */

import { describe, test } from 'node:test';
import { expect } from '../test-helpers.js';
import type { AttachmentRef } from '@maka/core/events';
import type {
  UserMessage,
  AssistantMessage,
  SystemNoteMessage,
  ToolCallMessage,
  ToolResultMessage,
  TokenUsageMessage,
  PermissionDecisionMessage,
  TurnStateMessage,
  StoredMessage,
} from '@maka/core/session';
import type { RuntimeEvent, RuntimeEventContent } from '@maka/core/runtime-event';
import {
  storedMessageToRuntimeEvent,
  storedMessageToRuntimeEvents,
  runtimeEventToStoredMessageDraft,
} from '../runtime-event-adapters.js';
import {
  buildModelHistoryFromRuntimeEvents,
  buildRuntimeEventModelReplayPlan,
  buildSteeringEnvelope,
  buildTextModelMessagesFromRuntimeEvents,
  collectToolActivityTurnIds,
  type ModelHistoryEntry,
  steeringMessagesMissingFromBase,
  steeringModelMessage,
  steeringProviderOptions,
} from '../model-history.js';

// ---------- StoredMessage fixtures ----------

const ts = 1_700_000_000_000;
const turnId = 't1';

const attachment: AttachmentRef = {
  kind: 'pdf',
  name: 'brief.pdf',
  mimeType: 'application/pdf',
  bytes: 2048,
  ref: { kind: 'session_file', sessionId: 'sess-1', relativePath: 'attachments/brief.pdf' },
};

const user = (id: string, text: string): UserMessage => ({
  type: 'user',
  id,
  turnId,
  ts: ts + 1,
  text,
});

const assistant = (
  id: string,
  text: string,
  thinking?: { text: string; signature?: string },
): AssistantMessage => ({
  type: 'assistant',
  id,
  turnId,
  ts: ts + 2,
  text,
  modelId: 'claude-sonnet-4-5',
  ...(thinking ? { thinking } : {}),
});

const note = (id: string, kind: SystemNoteMessage['kind']): SystemNoteMessage => ({
  type: 'system_note',
  id,
  ts: ts + 3,
  kind,
});

const toolCall = (id: string, name: string, args: unknown = {}): ToolCallMessage => ({
  type: 'tool_call',
  id,
  turnId,
  ts: ts + 4,
  toolName: name,
  args,
});

const toolResult = (toolUseId: string, isError: boolean, text: string): ToolResultMessage => ({
  type: 'tool_result',
  id: `r-${toolUseId}`,
  turnId,
  ts: ts + 5,
  toolUseId,
  isError,
  content: { kind: 'text', text },
});

const tokens = (id: string): TokenUsageMessage => ({
  type: 'token_usage',
  id,
  turnId,
  ts: ts + 6,
  input: 10,
  output: 5,
});

const permission = (id: string): PermissionDecisionMessage => ({
  type: 'permission_decision',
  id,
  turnId,
  ts: ts + 7,
  toolUseId: 'tu-1',
  toolName: 'Write',
  decision: 'allow',
});

const turnState = (id: string): TurnStateMessage => ({
  type: 'turn_state',
  id,
  turnId,
  ts: ts + 8,
  status: 'completed',
  partialOutputRetained: false,
});

const ctx = {
  sessionId: 'sess-1',
  invocationId: 'inv-1',
  runId: 'run-1',
};

// ---------- RuntimeEvent fixtures ----------

let __seq = 0;
function ev(
  overrides: Partial<RuntimeEvent> & { content?: RuntimeEventContent } = {},
): RuntimeEvent {
  __seq += 1;
  return {
    id: `evt-${__seq}`,
    invocationId: 'inv-1',
    runId: 'run-1',
    sessionId: 'sess-1',
    turnId: 'turn-1',
    ts: ts + __seq,
    partial: false,
    role: 'user',
    author: 'user',
    ...overrides,
  };
}

// ============================================================================
// storedMessageToRuntimeEvent (singular)
// ============================================================================

describe('storedMessageToRuntimeEvent', () => {
  test('user message → role user, text content, refs link', () => {
    const e = storedMessageToRuntimeEvent(user('u1', 'hello'), ctx);
    expect(e).not.toBeNull();
    if (!e) return;
    expect(e.role).toBe('user');
    expect(e.author).toBe('user');
    expect(e.partial).toBe(false);
    expect(e.content).toEqual({ kind: 'text', text: 'hello' });
    expect(e.refs?.storedMessageId).toBe('u1');
    expect(e.sessionId).toBe('sess-1');
    expect(e.turnId).toBe(turnId);
    expect(e.ts).toBe(ts + 1);
  });

  test('user message with attachments preserves attachment refs in text content', () => {
    const e = storedMessageToRuntimeEvent(
      { ...user('u-attach', 'see attached'), attachments: [attachment] },
      ctx,
    );
    expect(e).not.toBeNull();
    if (!e) return;
    expect(e.content).toEqual({
      kind: 'text',
      text: 'see attached',
      attachments: [attachment],
    });
  });

  test('user message displayText round-trips through RuntimeEvent draft projection', () => {
    const typed = '/skill:alpha 帮我整理';
    const envelope = 'The user explicitly invoked…\n\n<user-message>\n帮我整理\n</user-message>';
    const e = storedMessageToRuntimeEvent(
      { ...user('u-skill', envelope), displayText: typed },
      ctx,
    );
    expect(e).not.toBeNull();
    if (!e) return;
    expect(e.content).toEqual({ kind: 'text', text: envelope, displayText: typed });
    const draft = runtimeEventToStoredMessageDraft(e);
    expect(draft).toMatchObject({ type: 'user', text: envelope, displayText: typed });
  });

  test('assistant message (text only) → role model, text content; thinking dropped', () => {
    const e = storedMessageToRuntimeEvent(assistant('a1', 'hi'), ctx);
    if (!e) throw new Error('expected event');
    expect(e.role).toBe('model');
    expect(e.author).toBe('agent');
    expect(e.content).toEqual({ kind: 'text', text: 'hi' });
  });

  test('system_note → role system, text content labels the note kind', () => {
    const e = storedMessageToRuntimeEvent(note('n1', 'session_start'), ctx);
    if (!e) throw new Error('expected event');
    expect(e.role).toBe('system');
    expect(e.author).toBe('system');
    expect(e.content).toEqual({ kind: 'text', text: 'system_note:session_start' });
  });

  test('tool_call → null (needs runtime-runner-owned mapping)', () => {
    expect(storedMessageToRuntimeEvent(toolCall('tc1', 'Read'), ctx)).toBeNull();
  });

  test('tool_result → null', () => {
    expect(storedMessageToRuntimeEvent(toolResult('tc1', false, 'data'), ctx)).toBeNull();
  });

  test('token_usage → null', () => {
    expect(storedMessageToRuntimeEvent(tokens('tu1'), ctx)).toBeNull();
  });

  test('permission_decision → null', () => {
    expect(storedMessageToRuntimeEvent(permission('pd1'), ctx)).toBeNull();
  });

  test('turn_state → null', () => {
    expect(storedMessageToRuntimeEvent(turnState('ts1'), ctx)).toBeNull();
  });

  test('context ts override is honored', () => {
    const e = storedMessageToRuntimeEvent(user('u', 'x'), { ...ctx, ts: 9999 });
    if (!e) throw new Error('expected event');
    expect(e.ts).toBe(9999);
  });

  test('context turnId override is honored (session-level note has no turnId)', () => {
    const e = storedMessageToRuntimeEvent(note('n', 'session_start'), {
      ...ctx,
      turnId: 'override-turn',
    });
    if (!e) throw new Error('expected event');
    expect(e.turnId).toBe('override-turn');
  });

  test('session-level note without turnId defaults to empty string', () => {
    const e = storedMessageToRuntimeEvent(note('n', 'session_resume'), ctx);
    if (!e) throw new Error('expected event');
    expect(e.turnId).toBe('');
  });

  test('custom newId is used for generated event ids', () => {
    const e = storedMessageToRuntimeEvent(user('u', 'x'), {
      ...ctx,
      newId: () => 'fixed-id',
    });
    if (!e) throw new Error('expected event');
    expect(e.id).toBe('fixed-id');
  });
});

// ============================================================================
// storedMessageToRuntimeEvents (plural — captures thinking)
// ============================================================================

describe('storedMessageToRuntimeEvents', () => {
  test('assistant without thinking → single text event', () => {
    const out = storedMessageToRuntimeEvents(assistant('a1', 'hi'), ctx);
    expect(out).toHaveLength(1);
    expect(out[0]?.content?.kind).toBe('text');
  });

  test('assistant with thinking → [text event, thinking event]', () => {
    const out = storedMessageToRuntimeEvents(
      assistant('a2', 'answer', { text: 'reasoning', signature: 'sig-1' }),
      ctx,
    );
    expect(out).toHaveLength(2);
    expect(out[0]?.content).toEqual({ kind: 'text', text: 'answer' });
    expect(out[1]?.content).toEqual({
      kind: 'thinking',
      text: 'reasoning',
      signature: 'sig-1',
    });
    expect(out[1]?.role).toBe('model');
    expect(out[1]?.refs?.storedMessageId).toBe('a2');
  });

  test('user message → single event (same as singular)', () => {
    const out = storedMessageToRuntimeEvents(user('u', 'hello'), ctx);
    expect(out).toHaveLength(1);
    expect(out[0]?.content).toEqual({ kind: 'text', text: 'hello' });
  });

  test('user message with attachments → single attachment-preserving event', () => {
    const out = storedMessageToRuntimeEvents(
      { ...user('u-attach', 'see attached'), attachments: [attachment] },
      ctx,
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.content).toEqual({
      kind: 'text',
      text: 'see attached',
      attachments: [attachment],
    });
  });

  test('tool_call → empty array', () => {
    expect(storedMessageToRuntimeEvents(toolCall('tc', 'Read'), ctx)).toEqual([]);
  });

  test('assistant with empty thinking text → single text event only', () => {
    const out = storedMessageToRuntimeEvents(assistant('a3', 'hi', { text: '' }), ctx);
    expect(out).toHaveLength(1);
    expect(out[0]?.content?.kind).toBe('text');
  });
});

// ============================================================================
// runtimeEventToStoredMessageDraft
// ============================================================================

describe('runtimeEventToStoredMessageDraft', () => {
  test('user text event → UserMessage', () => {
    const event = ev({
      role: 'user',
      author: 'user',
      content: { kind: 'text', text: 'hello' },
      refs: { storedMessageId: 'u1' },
    });
    const draft = runtimeEventToStoredMessageDraft(event);
    expect(draft).not.toBeNull();
    if (!draft) return;
    expect(draft.type).toBe('user');
    if (draft.type !== 'user') return;
    expect(draft.id).toBe('u1');
    expect(draft.text).toBe('hello');
    expect(draft.turnId).toBe(event.turnId);
    expect(draft.ts).toBe(event.ts);
  });

  test('user text event with attachments → UserMessage with attachments', () => {
    const event = ev({
      role: 'user',
      author: 'user',
      content: { kind: 'text', text: 'see attached', attachments: [attachment] },
      refs: { storedMessageId: 'u-attach' },
    });
    const draft = runtimeEventToStoredMessageDraft(event);
    expect(draft).not.toBeNull();
    if (!draft || draft.type !== 'user') return;
    expect(draft.attachments).toEqual([attachment]);
  });

  test('model text event with modelId → AssistantMessage', () => {
    const event = ev({
      role: 'model',
      author: 'agent',
      content: { kind: 'text', text: 'answer' },
      refs: { storedMessageId: 'a1' },
    });
    const draft = runtimeEventToStoredMessageDraft(event, { modelId: 'gpt-4o' });
    expect(draft).not.toBeNull();
    if (!draft) return;
    expect(draft.type).toBe('assistant');
    if (draft.type !== 'assistant') return;
    expect(draft.id).toBe('a1');
    expect(draft.text).toBe('answer');
    expect(draft.modelId).toBe('gpt-4o');
  });

  test('model text event without modelId → null (no safe legacy shape)', () => {
    const event = ev({
      role: 'model',
      author: 'agent',
      content: { kind: 'text', text: 'answer' },
    });
    expect(runtimeEventToStoredMessageDraft(event)).toBeNull();
  });

  test('partial user and model text events → null', () => {
    const partialUser = ev({
      partial: true,
      role: 'user',
      author: 'user',
      content: { kind: 'text', text: 'typing...' },
    });
    const partialModel = ev({
      partial: true,
      role: 'model',
      author: 'agent',
      content: { kind: 'text', text: 'streaming...' },
    });

    expect(runtimeEventToStoredMessageDraft(partialUser)).toBeNull();
    expect(runtimeEventToStoredMessageDraft(partialModel, { modelId: 'gpt-4o' })).toBeNull();
  });

  test('thinking event → null', () => {
    const event = ev({
      role: 'model',
      author: 'agent',
      content: { kind: 'thinking', text: 'hmm' },
    });
    expect(runtimeEventToStoredMessageDraft(event, { modelId: 'm' })).toBeNull();
  });

  test('function_call event → null (tool projection owned elsewhere)', () => {
    const event = ev({
      role: 'model',
      author: 'agent',
      content: { kind: 'function_call', id: 'fc1', name: 'Read', args: {} },
    });
    expect(runtimeEventToStoredMessageDraft(event)).toBeNull();
  });

  test('function_response event → null', () => {
    const event = ev({
      role: 'tool',
      author: 'tool',
      content: {
        kind: 'function_response',
        id: 'fc1',
        name: 'Read',
        result: 'data',
        isError: false,
      },
    });
    expect(runtimeEventToStoredMessageDraft(event)).toBeNull();
  });

  test('actions-only event (token usage) → null', () => {
    const event = ev({
      role: 'system',
      author: 'system',
      actions: {
        tokenUsage: { input: 10, output: 5 },
      },
    });
    expect(runtimeEventToStoredMessageDraft(event)).toBeNull();
  });

  test('error-content event → null', () => {
    const event = ev({
      role: 'model',
      author: 'agent',
      content: { kind: 'error', message: 'boom' },
    });
    expect(runtimeEventToStoredMessageDraft(event)).toBeNull();
  });

  test('round-trip: user message → event → draft preserves text', () => {
    const original = user('orig', 'round-trip text');
    const event = storedMessageToRuntimeEvent(original, ctx);
    if (!event) throw new Error('expected event');
    const draft = runtimeEventToStoredMessageDraft(event);
    if (!draft || draft.type !== 'user') throw new Error('expected user draft');
    expect(draft.text).toBe('round-trip text');
    expect(draft.id).toBe('orig');
  });
});

// ============================================================================
// buildModelHistoryFromRuntimeEvents — policy
// ============================================================================

describe('buildModelHistoryFromRuntimeEvents', () => {
  test('empty input → empty history', () => {
    expect(buildModelHistoryFromRuntimeEvents([])).toEqual([]);
  });

  test('user + final model text → two entries in order', () => {
    const events: RuntimeEvent[] = [
      ev({ role: 'user', author: 'user', content: { kind: 'text', text: 'q' } }),
      ev({ role: 'model', author: 'agent', content: { kind: 'text', text: 'a' } }),
    ];
    const out = buildModelHistoryFromRuntimeEvents(events);
    expect(out).toHaveLength(2);
    expect(out[0]?.role).toBe('user');
    expect(out[1]?.role).toBe('model');
    expect(out[0]?.content).toEqual({ kind: 'text', text: 'q' });
  });

  test('POLICY: partial model chunks are excluded', () => {
    const events: RuntimeEvent[] = [
      ev({
        partial: true,
        role: 'model',
        author: 'agent',
        content: { kind: 'text', text: 'streaming chunk...' },
      }),
      ev({
        role: 'model',
        author: 'agent',
        content: { kind: 'text', text: 'final answer' },
      }),
    ];
    const out = buildModelHistoryFromRuntimeEvents(events);
    expect(out).toHaveLength(1);
    expect(out[0]?.content).toEqual({ kind: 'text', text: 'final answer' });
  });

  test('POLICY: function_call + function_response included by default', () => {
    const events: RuntimeEvent[] = [
      ev({
        role: 'user',
        author: 'user',
        content: { kind: 'text', text: 'read the file' },
      }),
      ev({
        role: 'model',
        author: 'agent',
        content: {
          kind: 'function_call',
          id: 'fc1',
          name: 'Read',
          args: { path: '/x' },
        },
      }),
      ev({
        role: 'tool',
        author: 'tool',
        content: {
          kind: 'function_response',
          id: 'fc1',
          name: 'Read',
          result: 'file contents',
          isError: false,
        },
      }),
      ev({
        role: 'model',
        author: 'agent',
        content: { kind: 'text', text: 'done' },
      }),
    ];
    const out = buildModelHistoryFromRuntimeEvents(events);
    expect(out).toHaveLength(4);
    expect(out.map((e) => e.role)).toEqual(['user', 'model', 'tool', 'model']);
    expect(out[1]?.content?.kind).toBe('function_call');
    expect(out[2]?.content?.kind).toBe('function_response');
  });

  test('POLICY: function_response with isError stays model-visible', () => {
    const events: RuntimeEvent[] = [
      ev({
        role: 'tool',
        author: 'tool',
        content: {
          kind: 'function_response',
          id: 'fc1',
          name: 'Write',
          result: 'denied',
          isError: true,
        },
      }),
    ];
    const out = buildModelHistoryFromRuntimeEvents(events);
    expect(out).toHaveLength(1);
    expect((out[0].content as { isError?: boolean }).isError).toBe(true);
  });

  test('POLICY: tool events excluded when includeToolEvents=false (text-only replay)', () => {
    const events: RuntimeEvent[] = [
      ev({ role: 'user', author: 'user', content: { kind: 'text', text: 'q' } }),
      ev({
        role: 'model',
        author: 'agent',
        content: { kind: 'function_call', id: 'fc1', name: 'Read', args: {} },
      }),
      ev({
        role: 'tool',
        author: 'tool',
        content: {
          kind: 'function_response',
          id: 'fc1',
          name: 'Read',
          result: 'data',
        },
      }),
      ev({ role: 'model', author: 'agent', content: { kind: 'text', text: 'a' } }),
    ];
    const out = buildModelHistoryFromRuntimeEvents(events, {
      includeToolEvents: false,
    });
    expect(out).toHaveLength(2);
    expect(out.map((e) => e.role)).toEqual(['user', 'model']);
  });

  test('POLICY: token-usage (actions-only) event excluded', () => {
    const events: RuntimeEvent[] = [
      ev({
        role: 'model',
        author: 'agent',
        content: { kind: 'text', text: 'a' },
        actions: { tokenUsage: { input: 100, output: 50 } },
      }),
      ev({
        role: 'system',
        author: 'system',
        actions: { tokenUsage: { input: 0, output: 0 } },
      }),
    ];
    const out = buildModelHistoryFromRuntimeEvents(events);
    expect(out).toHaveLength(1);
    expect(out[0]?.content?.kind).toBe('text');
  });

  test('POLICY: permission ack (actions-only) event excluded', () => {
    const events: RuntimeEvent[] = [
      ev({
        role: 'system',
        author: 'system',
        actions: {
          permissionDecision: {
            requestId: 'req-1',
            decision: 'allow',
          },
        },
      }),
      ev({ role: 'user', author: 'user', content: { kind: 'text', text: 'q' } }),
    ];
    const out = buildModelHistoryFromRuntimeEvents(events);
    expect(out).toHaveLength(1);
    expect(out[0]?.role).toBe('user');
  });

  test('POLICY: error-only content event excluded', () => {
    const events: RuntimeEvent[] = [
      ev({
        role: 'model',
        author: 'agent',
        content: { kind: 'error', message: 'something broke' },
      }),
      ev({ role: 'model', author: 'agent', content: { kind: 'text', text: 'a' } }),
    ];
    const out = buildModelHistoryFromRuntimeEvents(events);
    expect(out).toHaveLength(1);
    expect(out[0]?.content?.kind).toBe('text');
  });

  test('POLICY: system-role (UI note) event excluded by default', () => {
    const events: RuntimeEvent[] = [
      ev({
        role: 'system',
        author: 'system',
        content: { kind: 'text', text: 'system_note:session_start' },
      }),
      ev({ role: 'user', author: 'user', content: { kind: 'text', text: 'q' } }),
    ];
    const out = buildModelHistoryFromRuntimeEvents(events);
    expect(out).toHaveLength(1);
    expect(out[0]?.role).toBe('user');
  });

  test('POLICY: system-role event included when includeSystemEvents=true', () => {
    const events: RuntimeEvent[] = [
      ev({
        role: 'system',
        author: 'system',
        content: { kind: 'text', text: 'You are a helpful assistant.' },
      }),
      ev({ role: 'user', author: 'user', content: { kind: 'text', text: 'q' } }),
    ];
    const out = buildModelHistoryFromRuntimeEvents(events, {
      includeSystemEvents: true,
    });
    expect(out).toHaveLength(2);
    expect(out[0]?.role).toBe('system');
  });

  test('POLICY: thinking excluded by default, included when includeThinking=true', () => {
    const events: RuntimeEvent[] = [
      ev({
        role: 'model',
        author: 'agent',
        content: { kind: 'thinking', text: 'reasoning', signature: 's' },
      }),
      ev({ role: 'model', author: 'agent', content: { kind: 'text', text: 'a' } }),
    ];
    expect(buildModelHistoryFromRuntimeEvents(events)).toHaveLength(1);
    const out = buildModelHistoryFromRuntimeEvents(events, {
      includeThinking: true,
    });
    expect(out).toHaveLength(2);
    expect(out[0]?.content?.kind).toBe('thinking');
  });

  test('endInvocation terminal marker with no content → excluded', () => {
    const events: RuntimeEvent[] = [
      ev({ role: 'user', author: 'user', content: { kind: 'text', text: 'q' } }),
      ev({
        role: 'model',
        author: 'agent',
        status: 'completed',
        actions: { endInvocation: true },
      }),
    ];
    const out = buildModelHistoryFromRuntimeEvents(events);
    expect(out).toHaveLength(1);
    expect(out[0]?.role).toBe('user');
  });

  test('entries preserve event order and carry eventId + ts', () => {
    const events: RuntimeEvent[] = [
      ev({ role: 'user', author: 'user', content: { kind: 'text', text: 'a' } }),
      ev({ role: 'model', author: 'agent', content: { kind: 'text', text: 'b' } }),
      ev({ role: 'user', author: 'user', content: { kind: 'text', text: 'c' } }),
    ];
    const out = buildModelHistoryFromRuntimeEvents(events);
    expect(out.map((e) => e.eventId)).toEqual(events.map((e) => e.id));
    expect(out.map((e) => e.ts)).toEqual(events.map((e) => e.ts));
  });

  test('full durable-history-shaped stream: partials + finals + diagnostics', () => {
    // Mirrors a realistic turn: streaming chunks (partial), final assistant
    // text, tool call/response, token usage, system note, terminal marker.
    const events: RuntimeEvent[] = [
      ev({
        partial: true,
        role: 'model',
        author: 'agent',
        content: { kind: 'text', text: 'Let me ' },
      }),
      ev({
        partial: true,
        role: 'model',
        author: 'agent',
        content: { kind: 'text', text: 'Let me check' },
      }),
      ev({
        role: 'model',
        author: 'agent',
        content: {
          kind: 'function_call',
          id: 'fc1',
          name: 'Read',
          args: { path: '/a' },
        },
      }),
      ev({
        role: 'tool',
        author: 'tool',
        content: {
          kind: 'function_response',
          id: 'fc1',
          name: 'Read',
          result: 'contents',
        },
      }),
      ev({
        role: 'model',
        author: 'agent',
        content: { kind: 'text', text: 'Here is the file.' },
      }),
      ev({
        role: 'system',
        author: 'system',
        actions: { tokenUsage: { input: 10, output: 5 } },
      }),
      ev({
        role: 'system',
        author: 'system',
        content: { kind: 'text', text: 'system_note:mode_change' },
      }),
      ev({
        role: 'model',
        author: 'agent',
        status: 'completed',
        actions: { endInvocation: true },
      }),
    ];
    const out = buildModelHistoryFromRuntimeEvents(events);
    // Only: function_call, function_response, final text.
    expect(out.map((e) => e.content?.kind)).toEqual(['function_call', 'function_response', 'text']);
  });

  test('text-only AI SDK projection skips unsupported entries and preserves user attachment refs', () => {
    const events: RuntimeEvent[] = [
      ev({
        role: 'user',
        author: 'user',
        content: { kind: 'text', text: 'see attached', attachments: [attachment] },
      }),
      ev({
        partial: true,
        role: 'model',
        author: 'agent',
        content: { kind: 'text', text: 'partial' },
      }),
      ev({
        role: 'system',
        author: 'system',
        content: { kind: 'text', text: 'system note' },
      }),
      ev({
        role: 'model',
        author: 'agent',
        content: { kind: 'thinking', text: 'private reasoning' },
      }),
      ev({
        role: 'model',
        author: 'agent',
        content: { kind: 'function_call', id: 'fc1', name: 'Read', args: {} },
      }),
      ev({
        role: 'tool',
        author: 'tool',
        content: { kind: 'function_response', id: 'fc1', name: 'Read', result: 'data' },
      }),
      ev({
        role: 'model',
        author: 'agent',
        content: { kind: 'text', text: 'final answer' },
      }),
      ev({
        role: 'model',
        author: 'agent',
        status: 'completed',
        actions: { endInvocation: true },
      }),
    ];

    expect(buildTextModelMessagesFromRuntimeEvents(events)).toEqual([
      {
        role: 'user',
        content: 'see attached\n\n[attachment: brief.pdf (application/pdf)]',
      },
      { role: 'assistant', content: 'final answer' },
    ]);
  });

  test('text-only projections keep the steering structured identity', () => {
    // Round-6 R4: the text-only projections (plan.textMessages and
    // buildTextModelMessagesFromRuntimeEvents) must carry the same
    // providerOptions steering marker as the full replay — a base that drops
    // the event id makes id-based dedupe blind, and a live injection of the
    // same message doubles it.
    const steered = ev({
      role: 'user',
      author: 'user',
      content: { kind: 'text', text: 'steer it', steering: true },
    });
    const events: RuntimeEvent[] = [
      ev({ role: 'user', author: 'user', content: { kind: 'text', text: 'ask' } }),
      steered,
    ];

    const textMessages = buildTextModelMessagesFromRuntimeEvents(events);
    expect(textMessages).toEqual([
      { role: 'user', content: 'ask' },
      {
        role: 'user',
        content: buildSteeringEnvelope('steer it'),
        providerOptions: steeringProviderOptions(steered.id),
      },
    ]);

    const plan = buildRuntimeEventModelReplayPlan(events);
    expect(plan.textMessages.at(-1)).toEqual({
      role: 'user',
      content: buildSteeringEnvelope('steer it'),
      providerOptions: steeringProviderOptions(steered.id),
    });

    // Id-based dedupe holds when this projection is the request base.
    const injected = steeringModelMessage(steered.id, buildSteeringEnvelope('steer it'));
    expect(steeringMessagesMissingFromBase([injected], textMessages)).toEqual([]);
    expect(steeringMessagesMissingFromBase([injected], plan.textMessages)).toEqual([]);
  });

  test('runtime replay plan preserves structured tool calls and results', () => {
    const events: RuntimeEvent[] = [
      ev({ role: 'user', author: 'user', content: { kind: 'text', text: 'read package' } }),
      ev({
        role: 'model',
        author: 'agent',
        content: {
          kind: 'function_call',
          id: 'tool-1',
          name: 'Read',
          args: { path: 'package.json' },
        },
      }),
      ev({
        role: 'tool',
        author: 'tool',
        content: {
          kind: 'function_response',
          id: 'tool-1',
          name: 'Read',
          result: { ok: true, text: 'contents' },
          isError: false,
        },
      }),
    ];

    const plan = buildRuntimeEventModelReplayPlan(events);

    expect(plan.hasProviderNativeSemantics).toBe(true);
    expect(plan.semanticKinds).toEqual(['text', 'tool_call', 'tool_result']);
    expect(plan.items).toEqual([
      {
        kind: 'text',
        role: 'user',
        content: 'read package',
        eventId: events[0]?.id,
        ts: events[0]?.ts,
      },
      {
        kind: 'tool_call',
        toolCallId: 'tool-1',
        toolName: 'Read',
        input: { path: 'package.json' },
        eventId: events[1]?.id,
        ts: events[1]?.ts,
      },
      {
        kind: 'tool_result',
        toolCallId: 'tool-1',
        toolName: 'Read',
        output: { ok: true, text: 'contents' },
        isError: false,
        eventId: events[2]?.id,
        ts: events[2]?.ts,
      },
    ]);
  });

  test('runtime replay plan normalizes an exact legacy terminal result', () => {
    const events: RuntimeEvent[] = [
      ev({
        role: 'model',
        author: 'agent',
        content: {
          kind: 'function_call',
          id: 'tool-1',
          name: 'Bash',
          args: { command: 'printf ok' },
        },
      }),
      ev({
        role: 'tool',
        author: 'tool',
        content: {
          kind: 'function_response',
          id: 'tool-1',
          name: 'Bash',
          result: {
            kind: 'terminal',
            cwd: '/tmp/work',
            cmd: 'printf ok',
            status: 'completed',
            exitCode: 0,
            stdout: 'ok',
            stderr: '',
            stdoutTruncated: false,
            stderrTruncated: false,
          },
          isError: false,
        },
      }),
    ];

    const result = buildRuntimeEventModelReplayPlan(events).items.find(
      (item) => item.kind === 'tool_result',
    );
    expect(result?.kind === 'tool_result' ? result.output : undefined).toEqual({
      kind: 'terminal',
      cwd: '/tmp/work',
      cmd: 'printf ok',
      status: 'completed',
      exitCode: 0,
      output: {
        mode: 'pipes',
        stdout: 'ok',
        stderr: '',
        stdoutTruncated: false,
        stderrTruncated: false,
        redacted: false,
      },
    });
  });

  test('runtime replay plan rejects a mixed legacy/current shell result', () => {
    const events: RuntimeEvent[] = [
      ev({
        role: 'model',
        author: 'agent',
        content: {
          kind: 'function_call',
          id: 'tool-1',
          name: 'Bash',
          args: { command: 'printf bad' },
        },
      }),
      ev({
        role: 'tool',
        author: 'tool',
        content: {
          kind: 'function_response',
          id: 'tool-1',
          name: 'Bash',
          result: {
            kind: 'terminal',
            cwd: '/tmp/work',
            cmd: 'printf bad',
            status: 'completed',
            exitCode: 0,
            stdout: 'bad',
            stderr: '',
            stdoutTruncated: false,
            stderrTruncated: false,
            output: {
              mode: 'pipes',
              stdout: 'bad',
              stderr: '',
              stdoutTruncated: false,
              stderrTruncated: false,
              redacted: false,
            },
          },
          isError: false,
        },
      }),
    ];

    const plan = buildRuntimeEventModelReplayPlan(events);
    expect(plan.items.some((item) => item.kind === 'tool_result')).toBe(false);
    expect(plan.items.some((item) => item.kind === 'tool_call')).toBe(false);
    expect(plan.hasProviderNativeSemantics).toBe(false);
    expect(plan.diagnostics.map((diagnostic) => diagnostic.code)).toContain('unsupported_content');
  });

  test('runtime replay plan carries thinking separately and text replay never leaks it', () => {
    const events: RuntimeEvent[] = [
      ev({
        role: 'model',
        author: 'agent',
        content: { kind: 'thinking', text: 'private reasoning', signature: 'sig-1' },
      }),
      ev({ role: 'model', author: 'agent', content: { kind: 'text', text: 'public answer' } }),
    ];

    const plan = buildRuntimeEventModelReplayPlan(events);

    expect(plan.items.map((item) => item.kind)).toEqual(['thinking', 'text']);
    expect(plan.textMessages).toEqual([{ role: 'assistant', content: 'public answer' }]);
    expect(buildTextModelMessagesFromRuntimeEvents(events)).toEqual([
      { role: 'assistant', content: 'public answer' },
    ]);
  });

  test('runtime replay plan skips unsigned thinking instead of flattening or blocking it', () => {
    const events: RuntimeEvent[] = [
      ev({
        role: 'model',
        author: 'agent',
        content: { kind: 'thinking', text: 'private reasoning' },
      }),
      ev({ role: 'model', author: 'agent', content: { kind: 'text', text: 'answer' } }),
    ];

    const plan = buildRuntimeEventModelReplayPlan(events);

    // Unsigned thinking is skipped from native items and never claims the
    // 'thinking' semantic kind, but is recorded non-blockingly for observability.
    expect(plan.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'unsigned_thinking_skipped',
    );
    expect(plan.items.map((item) => item.kind)).toEqual(['text']);
    expect(plan.semanticKinds).not.toContain('thinking');
    expect(plan.textMessages).toEqual([{ role: 'assistant', content: 'answer' }]);
  });

  test('unsigned thinking does not downgrade native tool replay for the rest of the history', () => {
    const events: RuntimeEvent[] = [
      ev({ role: 'user', author: 'user', content: { kind: 'text', text: 'do it' } }),
      // Non-Anthropic reasoning: thinking persisted with no signature.
      ev({
        role: 'model',
        author: 'agent',
        content: { kind: 'thinking', text: 'reason without a signature' },
      }),
      ev({
        role: 'model',
        author: 'agent',
        content: {
          kind: 'function_call',
          id: 'tool-1',
          name: 'Read',
          args: { path: 'package.json' },
        },
      }),
      ev({
        role: 'tool',
        author: 'tool',
        content: {
          kind: 'function_response',
          id: 'tool-1',
          name: 'Read',
          result: 'contents',
          isError: false,
        },
      }),
    ];

    const plan = buildRuntimeEventModelReplayPlan(events);

    // The tool call/result remain native; the unsigned thinking is simply omitted.
    expect(plan.hasProviderNativeSemantics).toBe(true);
    expect(plan.items.map((item) => item.kind)).toEqual(['text', 'tool_call', 'tool_result']);
    expect(plan.semanticKinds).not.toContain('thinking');
    // No blocking diagnostic classes present (only the non-blocking skip note).
    const codes = plan.diagnostics.map((diagnostic) => diagnostic.code);
    expect(codes).toContain('unsigned_thinking_skipped');
    expect(codes).not.toContain('unsupported_role');
    expect(codes).not.toContain('unsupported_content');
    expect(codes).not.toContain('unmatched_tool_result');
    expect(codes).not.toContain('tool_id_mismatch');
  });

  test('signed thinking still enters native replay items with its signature', () => {
    const events: RuntimeEvent[] = [
      ev({
        role: 'model',
        author: 'agent',
        content: { kind: 'thinking', text: 'signed reasoning', signature: 'sig-9' },
      }),
      ev({ role: 'model', author: 'agent', content: { kind: 'text', text: 'answer' } }),
    ];

    const plan = buildRuntimeEventModelReplayPlan(events);

    expect(plan.items.map((item) => item.kind)).toEqual(['thinking', 'text']);
    const thinking = plan.items.find((item) => item.kind === 'thinking');
    expect(thinking && thinking.kind === 'thinking' ? thinking.signature : undefined).toBe('sig-9');
    expect(plan.semanticKinds).toContain('thinking');
    const pureCodes = plan.diagnostics.map((diagnostic) => diagnostic.code);
    expect(pureCodes).not.toContain('unsigned_thinking_skipped');
    // Boundary: the tool-turn skip must NOT swallow a pure-reasoning turn.
    expect(pureCodes).not.toContain('signed_thinking_in_tool_turn_skipped');
  });

  test('signed thinking in a tool-calling turn is skipped from replay, tool calls stay native', () => {
    // Anthropic tool turn as the backend emits it: the turn's reasoning is a
    // single end-of-turn thinking_complete pushed AFTER the tool events, so the
    // signed thinking lands last in ledger order. Materialization can only
    // render it as a standalone assistant reasoning message; after the tool
    // result that drops the leading thinking block Anthropic requires on the
    // tool-use assistant message AND leaves an orphan thinking block — a 400.
    // Skip it from replay (it stays in the read-model for the UI). Removing the
    // skip re-adds a 'thinking' item after 'tool_result' and fails this test.
    const events: RuntimeEvent[] = [
      ev({ role: 'user', author: 'user', content: { kind: 'text', text: 'read package' } }),
      ev({
        role: 'model',
        author: 'agent',
        content: {
          kind: 'function_call',
          id: 'tool-1',
          name: 'Read',
          args: { path: 'package.json' },
        },
      }),
      ev({
        role: 'tool',
        author: 'tool',
        content: {
          kind: 'function_response',
          id: 'tool-1',
          name: 'Read',
          result: 'contents',
          isError: false,
        },
      }),
      ev({
        role: 'model',
        author: 'agent',
        content: {
          kind: 'thinking',
          text: 'signed reasoning about the tool result',
          signature: 'sig-tool',
        },
      }),
      ev({ role: 'model', author: 'agent', content: { kind: 'text', text: 'here is the answer' } }),
    ];

    const plan = buildRuntimeEventModelReplayPlan(events);

    expect(plan.items.map((item) => item.kind)).toEqual([
      'text',
      'tool_call',
      'tool_result',
      'text',
    ]);
    expect(plan.semanticKinds).not.toContain('thinking');
    expect(plan.hasProviderNativeSemantics).toBe(true);
    const codes = plan.diagnostics.map((diagnostic) => diagnostic.code);
    expect(codes).toContain('signed_thinking_in_tool_turn_skipped');
    // Non-blocking: the tool call/result still replay provider-native.
    expect(codes).not.toContain('unsupported_role');
    expect(codes).not.toContain('unsupported_content');
    expect(codes).not.toContain('unmatched_tool_result');
    expect(codes).not.toContain('tool_id_mismatch');
  });

  test('a budget/search slice still skips a tool-turn signed thinking via full-ledger tool ids', () => {
    // Full prior ledger: a tool turn (tool_call, tool_result, signed thinking).
    const fullLedger: RuntimeEvent[] = [
      ev({
        role: 'model',
        author: 'agent',
        content: { kind: 'function_call', id: 'tool-1', name: 'Read', args: {} },
      }),
      ev({
        role: 'tool',
        author: 'tool',
        content: {
          kind: 'function_response',
          id: 'tool-1',
          name: 'Read',
          result: 'x',
          isError: false,
        },
      }),
      ev({
        role: 'model',
        author: 'agent',
        content: {
          kind: 'thinking',
          text: 'reasoning about the tool result',
          signature: 'sig-slice',
        },
      }),
    ];
    // history-search / budget pruning kept ONLY the query-matched signed
    // thinking; the same turn's tool_call/tool_result were dropped from replay.
    const slice = [fullLedger[2]!];

    // Scanning only the slice looks like a pure-reasoning turn — the latent hole
    // the full-ledger ids close: the thinking would otherwise replay native.
    const naive = buildRuntimeEventModelReplayPlan(slice);
    expect(naive.items.map((item) => item.kind)).toEqual(['thinking']);

    // Seeding the tool-turn ids from the full ledger restores the skip.
    const plan = buildRuntimeEventModelReplayPlan(slice, {
      toolActivityTurnIds: collectToolActivityTurnIds(fullLedger),
    });
    expect(plan.items.map((item) => item.kind)).toEqual([]);
    expect(plan.semanticKinds).not.toContain('thinking');
    expect(plan.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'signed_thinking_in_tool_turn_skipped',
    );
  });

  test('terminal RuntimeEvents are diagnostic-only for replay semantics', () => {
    const events: RuntimeEvent[] = [
      ev({ role: 'user', author: 'user', content: { kind: 'text', text: 'q' } }),
      ev({
        role: 'model',
        author: 'agent',
        status: 'completed',
        actions: { endInvocation: true },
      }),
    ];

    const plan = buildRuntimeEventModelReplayPlan(events);

    expect(plan.items).toHaveLength(1);
    expect(plan.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'terminal_fact_diagnostic_only',
    );
  });

  test('error-content RuntimeEvents are diagnostic-only, never blocking', () => {
    // A run that errored (or was recovered after an app restart) lands error
    // events in the ledger: a non-terminal error fact from the flow, and a
    // terminal commit carrying the failure as error content. Neither is model
    // conversation — flagging them `unsupported_content` (a blocking
    // diagnostic) would degrade every later turn of the session to the
    // stored-message projection.
    const events: RuntimeEvent[] = [
      ev({ role: 'user', author: 'user', content: { kind: 'text', text: 'q' } }),
      ev({
        role: 'model',
        author: 'agent',
        content: { kind: 'function_call', id: 'tool-1', name: 'Bash', args: { command: 'ls' } },
      }),
      ev({
        role: 'tool',
        author: 'tool',
        content: {
          kind: 'function_response',
          id: 'tool-1',
          name: 'Bash',
          result: { ok: true },
          isError: false,
        },
      }),
      // Non-terminal error fact (ai-sdk-flow: the terminal complete follows).
      ev({
        role: 'system',
        author: 'system',
        content: { kind: 'error', code: 'api_error', reason: 'api_error', message: 'boom' },
      }),
      // Terminal recovery commit (terminal-run-commit after an app restart).
      ev({
        role: 'system',
        author: 'system',
        status: 'failed',
        content: {
          kind: 'error',
          code: 'app_restarted',
          reason: 'app_restarted',
          message: 'app_restarted',
        },
        actions: { endInvocation: true },
      }),
    ];

    const plan = buildRuntimeEventModelReplayPlan(events);

    const codes = plan.diagnostics.map((diagnostic) => diagnostic.code);
    expect(codes).not.toContain('unsupported_content');
    expect(codes.filter((code) => code === 'error_content_diagnostic_only')).toHaveLength(2);
    expect(plan.items.map((item) => item.kind)).toEqual(['text', 'tool_call', 'tool_result']);
    expect(plan.hasProviderNativeSemantics).toBe(true);
  });

  test('drops a tool call whose result never landed in the ledger', () => {
    // A crash during tool execution persists the function_call but never its
    // function_response (recovery then appends a terminal error event). A
    // replayed tool_use with no tool_result is a provider 400, so the planner
    // must drop the dangling call — mirroring the deliberately non-blocking
    // unmatched_tool_result handling — instead of replaying or blocking.
    const events: RuntimeEvent[] = [
      ev({ role: 'user', author: 'user', content: { kind: 'text', text: 'q' } }),
      ev({
        role: 'model',
        author: 'agent',
        content: {
          kind: 'function_call',
          id: 'tool-1',
          name: 'Bash',
          args: { command: 'sleep 999' },
        },
      }),
      ev({
        role: 'system',
        author: 'system',
        status: 'failed',
        content: {
          kind: 'error',
          code: 'app_restarted',
          reason: 'app_restarted',
          message: 'app_restarted',
        },
        actions: { endInvocation: true },
      }),
    ];

    const plan = buildRuntimeEventModelReplayPlan(events);

    expect(plan.items.map((item) => item.kind)).toEqual(['text']);
    expect(plan.semanticKinds).not.toContain('tool_call');
    expect(plan.hasProviderNativeSemantics).toBe(false);
    const codes = plan.diagnostics.map((diagnostic) => diagnostic.code);
    expect(codes).toContain('unmatched_tool_call');
    expect(codes).not.toContain('unsupported_content');
  });
});

// ============================================================================
// Adapter + projection integration
// ============================================================================

describe('adapter → projection integration', () => {
  test('legacy messages convert to events then project to clean history', () => {
    const messages: StoredMessage[] = [
      user('u1', 'what is 2+2?'),
      assistant('a1', 'it is 4'),
      tokens('tu1'),
      note('n1', 'mode_change'),
    ];
    const events: RuntimeEvent[] = [];
    for (const m of messages) {
      events.push(...storedMessageToRuntimeEvents(m, ctx));
    }
    // Only user + assistant text survive projection (system note excluded,
    // token_usage never produced an event).
    const history = buildModelHistoryFromRuntimeEvents(events);
    expect(history).toHaveLength(2);
    expect(history[0]?.role).toBe('user');
    expect(history[1]?.role).toBe('model');
    expect((history[0].content as { text: string }).text).toBe('what is 2+2?');
  });

  test('ModelHistoryEntry type carries the discriminated content union', () => {
    const entry: ModelHistoryEntry = {
      role: 'model',
      content: { kind: 'function_call', id: 'fc1', name: 'Read', args: {} },
      ts: 1,
      eventId: 'e1',
    };
    if (entry.content.kind === 'function_call') {
      expect(entry.content.name).toBe('Read');
    } else {
      throw new Error('discriminator failed');
    }
  });
});

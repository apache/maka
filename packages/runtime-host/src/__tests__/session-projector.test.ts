import assert from 'node:assert/strict';
import test from 'node:test';
import type { StoredMessage } from '@maka/core';
import { RuntimeHostSessionProjector } from '../adapter/session-projector.js';
import type { SessionContinuitySnapshot, SubscriptionFrame } from '../protocol/index.js';

test('applies authoritative replacement once and does not complete it again at Turn terminal', () => {
  const projector = new RuntimeHostSessionProjector(
    snapshot(),
    [assistant('message-1', 'draft')],
    () => 10,
    [{ kind: 'text', turnId: 'turn-1', messageId: 'message-1' }],
  );

  assert.deepEqual(
    projector.seedActive(true).map((event) => event.type),
    ['text_delta'],
  );
  assert.deepEqual(projector.accept(deltaFrame(1, 0, 'final', { reset: true })).events, []);
  const completed = projector.accept(deltaFrame(2, 5, '', { complete: true })).events;
  assert.deepEqual(
    completed.map((event) => [event.type, 'text' in event ? event.text : '']),
    [['text_complete', 'final']],
  );
  assert.deepEqual(projector.seedActive(true), []);

  const terminal = projector.accept({
    kind: 'subscription.session_projection',
    hostEpoch: 'host-1',
    subscriptionId: 'subscription-1',
    sequence: 3,
    snapshot: snapshot({
      projectionRevision: 2,
      rootTurn: {
        sessionId: 'session-1',
        turnId: 'turn-1',
        runId: 'run-1',
        status: 'completed',
        terminalEventId: 'terminal-1',
      },
    }),
  }).events;
  assert.deepEqual(
    terminal.map((event) => event.type),
    ['complete'],
  );
});

test('seeds only streams identified as active by the Host catch-up state', () => {
  const transcript: StoredMessage[] = [
    assistant('completed-step', 'done'),
    {
      ...assistant('active-step', ''),
      thinking: { text: 'still working' },
    },
  ];
  const projector = new RuntimeHostSessionProjector(snapshot(), transcript, () => 10, [
    { kind: 'thinking', turnId: 'turn-1', messageId: 'active-step' },
  ]);

  assert.deepEqual(
    projector
      .seedActive(true)
      .map((event) => [event.type, 'messageId' in event && event.messageId]),
    [['thinking_delta', 'active-step']],
  );
});

function deltaFrame(
  sequence: number,
  startOffset: number,
  text: string,
  flags: { reset?: true; complete?: true } = {},
): SubscriptionFrame {
  return {
    kind: 'subscription.session_delta',
    hostEpoch: 'host-1',
    subscriptionId: 'subscription-1',
    sequence,
    sessionId: 'session-1',
    delta: {
      kind: 'text',
      turnId: 'turn-1',
      runId: 'run-1',
      messageId: 'message-1',
      startOffset,
      text,
      ...flags,
    },
  };
}

function snapshot(overrides: Partial<SessionContinuitySnapshot> = {}): SessionContinuitySnapshot {
  return {
    schemaVersion: 3,
    session: {
      sessionId: 'session-1',
      metadataRevision: 1,
      status: 'running',
      createdAt: 1,
      lastUsedAt: 1,
      isArchived: false,
    },
    projectionRevision: 1,
    rootTurn: {
      sessionId: 'session-1',
      turnId: 'turn-1',
      runId: 'run-1',
      status: 'running',
    },
    goal: null,
    queue: { hostEpoch: 'host-1', queueRevision: 0, steering: [], followup: [] },
    interactions: { pending: [] },
    ...overrides,
  };
}

function assistant(id: string, text: string): Extract<StoredMessage, { type: 'assistant' }> {
  return {
    type: 'assistant',
    id,
    turnId: 'turn-1',
    ts: 1,
    text,
    modelId: 'gpt-5',
  };
}
